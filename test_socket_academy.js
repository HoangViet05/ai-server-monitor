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

// Listen for academy_started event
socket.on("academy_started", (data) => {
    console.log("\n>>> EVENT RECEIVED: academy_started <<<");
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

// Listen for academy_update event
socket.on("academy_update", (data) => {
    console.log("\n>>> EVENT RECEIVED: academy_update <<<");
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

// Listen for academy_pattern_matched event
socket.on("academy_pattern_matched", (data) => {
    console.log("\n>>> EVENT RECEIVED: academy_pattern_matched <<<");
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

// Listen for academy_position_check event
const STATUS_EMOJI = {
    correct_position: "✅",
    wrong_position: "⚠️",
    not_on_table: "❌",
    out_of_scope: "➕",
};

const fmtNorm = (v) => (v == null ? "null" : Number(v).toFixed(4));

socket.on("academy_position_check", (data) => {
    console.log("\n>>> EVENT RECEIVED: academy_position_check <<<");
    console.log(`Camera ID: ${data.cameraId}`);
    console.log(`Academy Result ID: ${data.academyResultId}`);
    console.log(`Matched Mode: ${data.matchedMode}`);
    console.log(`Number of balls: ${data.balls.length}`);
    console.log("\nBalls Status:");

    data.balls.forEach((ball, index) => {
        const emoji = STATUS_EMOJI[ball.status] || "❓";
        console.log(`  ${index + 1}. Ball #${ball.number} ${emoji} ${ball.status}`);

        if (ball.status === "out_of_scope") {
            console.log(`     Current: (${ball.currentX}, ${ball.currentY})  norm=(${fmtNorm(ball.currentX_norm)}, ${fmtNorm(ball.currentY_norm)})`);
            console.log(`     Required: — (not in pattern)`);
        } else if (ball.currentX !== null) {
            console.log(`     Current:  (${ball.currentX}, ${ball.currentY})  norm=(${fmtNorm(ball.currentX_norm)}, ${fmtNorm(ball.currentY_norm)})`);
            console.log(`     Required: (${ball.requiredX}, ${ball.requiredY})  norm=(${fmtNorm(ball.requiredX_norm)}, ${fmtNorm(ball.requiredY_norm)})`);
        } else {
            console.log(`     Not detected on table`);
            console.log(`     Required: (${ball.requiredX}, ${ball.requiredY})  norm=(${fmtNorm(ball.requiredX_norm)}, ${fmtNorm(ball.requiredY_norm)})`);
        }
    });

    const by = (s) => data.balls.filter((b) => b.status === s).length;
    console.log(
        `\nSummary: ✅ ${by("correct_position")} correct | ⚠️ ${by("wrong_position")} wrong | ❌ ${by("not_on_table")} missing | ➕ ${by("out_of_scope")} out_of_scope`
    );
    console.log("---------------------------------------\n");
});

// Keep the script running
console.log("Waiting for academy_started, academy_update, academy_pattern_matched and academy_position_check events...");
