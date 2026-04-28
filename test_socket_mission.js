const { io } = require("socket.io-client");

// Server base URL (không kèm namespace)
const BASE_URL = process.env.SOCKET_BASE_URL || "https://academy.arenabilliard.com";

// Scoreboard ID for testing — overridable via env var
const SCOREBOARD_ID = process.env.SCOREBOARD_ID || "4ded13ec-93f2-4996-b003-4e2b317305d4";

console.log(`Connecting to ${BASE_URL}/missions with scoreboardId: ${SCOREBOARD_ID}...`);

const socket = io(`${BASE_URL}/missions`, {
    path: "/socket.io",
    query: {
        scoreboardId: SCOREBOARD_ID
    },
    transports: ["websocket"],
});

socket.on("connect", () => {
    console.log(`[CONNECTED] Socket ID: ${socket.id}`);
});

socket.on("connect_error", (err) => {
    console.error(`[ERROR] Connection failed: ${err.message}`);
});

socket.on("disconnect", (reason) => {
    console.log(`[DISCONNECTED] Reason: ${reason}`);
});

// Listen for mission_started event
socket.on("mission_started", (data) => {
    console.log("\n>>> EVENT RECEIVED: mission_started <<<");
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

// Listen for mission_update event
socket.on("mission_update", (data) => {
    console.log("\n>>> EVENT RECEIVED: mission_update <<<");
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

socket.on("mission_pattern_matched", (data) => {
    console.log("\n>>> EVENT RECEIVED: mission_pattern_matched <<<");
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

// Listen for mission_position_check event
socket.on("mission_position_check", (data) => {
    console.log("\n>>> EVENT RECEIVED: mission_position_check <<<");
    console.log(`Camera ID: ${data.cameraId}`);
    console.log(`Mission Result ID: ${data.missionResultId}`);
    console.log(`Number of balls: ${data.balls.length}`);
    console.log("\nBalls Status:");
    
    data.balls.forEach((ball, index) => {
        const statusEmoji = {
            "correct_position": "✅",
            "wrong_position": "⚠️",
            "not_on_table": "❌"
        }[ball.status] || "❓";
        
        console.log(`  ${index + 1}. Ball #${ball.number} ${statusEmoji} ${ball.status}`);
        if (ball.currentX !== null) {
            console.log(`     Current: (${ball.currentX}, ${ball.currentY})`);
            console.log(`     Required: (${ball.requiredX}, ${ball.requiredY})`);
        } else {
            console.log(`     Not detected on table`);
            console.log(`     Required: (${ball.requiredX}, ${ball.requiredY})`);
        }
    });
    
    const correctCount = data.balls.filter(b => b.status === "correct_position").length;
    const wrongCount = data.balls.filter(b => b.status === "wrong_position").length;
    const missingCount = data.balls.filter(b => b.status === "not_on_table").length;
    
    console.log(`\nSummary: ✅ ${correctCount} correct | ⚠️ ${wrongCount} wrong | ❌ ${missingCount} missing`);
    console.log("---------------------------------------\n");
});

// Keep the script running
console.log("Waiting for mission_started, mission_update, mission_pattern_matched and mission_position_check events...");
