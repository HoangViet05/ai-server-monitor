const { io } = require("socket.io-client");

// Server base URL (không kèm namespace)
const BASE_URL = process.env.SOCKET_BASE_URL || "https://academy.arenabilliard.com"; //dev
// const BASE_URL = process.env.SOCKET_BASE_URL || "https://api-ai-prod.arenabilliard.com"; //prod

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

// ─── Rule types ─────────────────────────────────────────────────────────────
// Mission hiện dùng pattern theo số bi (nine_ball). Các rule number-agnostic mới
// (single_target / multi_target / multi_target_ordered) chủ yếu cho academy,
// nhưng position-check.service dùng chung nên mission_position_check cũng có thể
// kèm `ruleType` + `detectedNumber` + `note` nếu sau này mission áp dụng.
const RULE_LABELS = {
    nine_ball: "9-Ball (theo số bi)",
    nine_ball_free_cue: "9-Ball - tự do bi cái",
    single_target: "Single Target (1 mục tiêu)",
    multi_target: "Multi Target (nhiều mục tiêu, không thứ tự)",
    multi_target_ordered: "Multi Target Ordered (nhiều mục tiêu, CÓ thứ tự)",
};

const NUMBER_AGNOSTIC_RULES = new Set([
    "single_target",
    "multi_target",
    "multi_target_ordered",
]);

const fmtRule = (rt) => (rt ? `${RULE_LABELS[rt] || rt} [${rt}]` : "(không có ruleType — luật cũ)");
const fmtNorm = (v) => (v == null ? "null" : Number(v).toFixed(4));

// Listen for mission_started event
socket.on("mission_started", (data) => {
    console.log("\n>>> EVENT RECEIVED: mission_started <<<");
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

// Listen for mission_update event
socket.on("mission_update", (data) => {
    console.log("\n>>> EVENT RECEIVED: mission_update <<<");
    if (Array.isArray(data?.history)) {
        data.history.forEach((h, i) => {
            console.log(
                `  Turn ${i + 1}: status=${h.status} score=${h.score} isFoul=${h.isFoul}` +
                (h.foulReason ? ` foulReason=${h.foulReason}` : "") +
                (h.videoUrl ? ` video=✔` : "")
            );
        });
    }
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

socket.on("mission_pattern_matched", (data) => {
    console.log("\n>>> EVENT RECEIVED: mission_pattern_matched <<<");
    console.log(`  ${data?.message || ""}`);
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

// Listen for mission_position_check event
const STATUS_EMOJI = {
    correct_position: "✅",
    wrong_position: "⚠️",
    not_on_table: "❌",
    out_of_scope: "➕",
};

socket.on("mission_position_check", (data) => {
    console.log("\n>>> EVENT RECEIVED: mission_position_check <<<");
    console.log(`Camera ID: ${data.cameraId}`);
    console.log(`Mission Result ID: ${data.missionResultId}`);
    if (data.ruleType) console.log(`Rule: ${fmtRule(data.ruleType)}`);
    if (data.matchedMode) console.log(`Matched Mode (flip): ${data.matchedMode}`);
    console.log(`Number of balls: ${data.balls.length}`);

    const numberAgnostic = NUMBER_AGNOSTIC_RULES.has(data.ruleType);
    const ordered = data.ruleType === "multi_target_ordered";
    const slotLabel = ordered ? "Rank" : numberAgnostic ? "Slot" : "Ball";

    console.log("\nBalls Status:");

    data.balls.forEach((ball, index) => {
        const emoji = STATUS_EMOJI[ball.status] || "❓";

        let header = `  ${index + 1}. ${slotLabel} #${ball.number}`;
        if (numberAgnostic && ball.detectedNumber != null && ball.detectedNumber !== ball.number) {
            header += ` (bi thật: #${ball.detectedNumber})`;
        } else if (numberAgnostic && ball.detectedNumber == null && ball.status !== "out_of_scope") {
            header += ` (chưa có bi)`;
        }
        console.log(`${header} ${emoji} ${ball.status}`);

        if (ball.status === "out_of_scope") {
            console.log(`     Current: (${ball.currentX}, ${ball.currentY})  norm=(${fmtNorm(ball.currentX_norm)}, ${fmtNorm(ball.currentY_norm)})`);
            console.log(`     Required: — (bi thừa, không thuộc pattern)`);
        } else if (ball.currentX !== null) {
            console.log(`     Current:  (${ball.currentX}, ${ball.currentY})  norm=(${fmtNorm(ball.currentX_norm)}, ${fmtNorm(ball.currentY_norm)})`);
            console.log(`     Required: (${ball.requiredX}, ${ball.requiredY})  norm=(${fmtNorm(ball.requiredX_norm)}, ${fmtNorm(ball.requiredY_norm)})`);
        } else {
            console.log(`     Not detected on table`);
            console.log(`     Required: (${ball.requiredX}, ${ball.requiredY})  norm=(${fmtNorm(ball.requiredX_norm)}, ${fmtNorm(ball.requiredY_norm)})`);
        }

        if (ball.note) {
            console.log(`     👉 ${ball.note}`);
        }
    });

    const by = (s) => data.balls.filter((b) => b.status === s).length;
    console.log(
        `\nSummary: ✅ ${by("correct_position")} correct | ⚠️ ${by("wrong_position")} wrong | ❌ ${by("not_on_table")} missing | ➕ ${by("out_of_scope")} out_of_scope`
    );
    console.log("---------------------------------------\n");
});

// Keep the script running
console.log("Waiting for mission_started, mission_update, mission_pattern_matched and mission_position_check events...");
