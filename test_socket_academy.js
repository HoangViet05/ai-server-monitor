const { io } = require("socket.io-client");

// Server base URL (không kèm namespace)
// const BASE_URL = process.env.SOCKET_BASE_URL || "https://academy.arenabilliard.com"; //dev
const BASE_URL = process.env.SOCKET_BASE_URL || "https://api-ai-prod.arenabilliard.com"; //prod

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

// ─── Rule types (academy) ──────────────────────────────────────────────────
// Nguồn: position-check.service.js → session.ruleType.
//   nine_ball            : luật 9-bi cổ điển (match theo số bi, có thứ tự lowest-first)
//   nine_ball_free_cue   : 9-bi nhưng được tự do đặt bi cái
//   single_target        : 1 bi cái + 1 bi mục tiêu (number-agnostic)
//   multi_target         : N bi mục tiêu, không cần thứ tự (number-agnostic)
//   multi_target_ordered : N bi mục tiêu, CÓ thứ tự — `number` của mỗi slot là
//                          RANK vị trí (1,2,3…), không phải số bi thật.
const RULE_LABELS = {
    nine_ball: "9-Ball (theo số bi)",
    nine_ball_free_cue: "9-Ball - tự do bi cái",
    single_target: "Single Target (1 mục tiêu)",
    multi_target: "Multi Target (nhiều mục tiêu, không thứ tự)",
    multi_target_ordered: "Multi Target Ordered (nhiều mục tiêu, CÓ thứ tự)",
};

// Number-agnostic rules: `number` trên mỗi ball là nhãn slot/rank, còn
// `detectedNumber` mới là số bi thật đang nằm ở slot đó (do BE ghép theo vị trí).
const NUMBER_AGNOSTIC_RULES = new Set([
    "single_target",
    "multi_target",
    "multi_target_ordered",
]);

const fmtRule = (rt) => (rt ? `${RULE_LABELS[rt] || rt} [${rt}]` : "(không có ruleType — luật cũ)");

// Listen for academy_started event
socket.on("academy_started", (data) => {
    console.log("\n>>> EVENT RECEIVED: academy_started <<<");
    if (data?.userPattern?.ruleType) {
        console.log(`Rule: ${fmtRule(data.userPattern.ruleType)}`);
    }
    console.log(JSON.stringify(data, null, 2));
    console.log("---------------------------------------\n");
});

// Listen for academy_update event
socket.on("academy_update", (data) => {
    console.log("\n>>> EVENT RECEIVED: academy_update <<<");
    if (data?.userPattern?.ruleType) {
        console.log(`Rule: ${fmtRule(data.userPattern.ruleType)}`);
    }
    // Tóm tắt nhanh các turn (score là số bi vào lỗ / tổng bi của pattern)
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

// Listen for academy_pattern_matched event
socket.on("academy_pattern_matched", (data) => {
    console.log("\n>>> EVENT RECEIVED: academy_pattern_matched <<<");
    console.log(`  ${data?.message || ""}`);
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
    console.log(`Rule: ${fmtRule(data.ruleType)}`);
    console.log(`Matched Mode (flip): ${data.matchedMode}`);
    console.log(`Number of balls: ${data.balls.length}`);

    const numberAgnostic = NUMBER_AGNOSTIC_RULES.has(data.ruleType);
    const ordered = data.ruleType === "multi_target_ordered";
    // Với các rule mới: `number` là nhãn slot. Với ordered, nó còn là thứ tự.
    const slotLabel = ordered ? "Rank" : numberAgnostic ? "Slot" : "Ball";

    console.log("\nBalls Status:");

    data.balls.forEach((ball, index) => {
        const emoji = STATUS_EMOJI[ball.status] || "❓";

        // Với rule number-agnostic, hiển thị thêm bi thật (detectedNumber) đang
        // nằm ở slot/rank này — BE ghép theo vị trí, không theo số bi.
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

        // Gợi ý di chuyển (chỉ có khi wrong_position)
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
console.log("Waiting for academy_started, academy_update, academy_pattern_matched and academy_position_check events...");
console.log("Rules được hỗ trợ: nine_ball, nine_ball_free_cue, single_target, multi_target, multi_target_ordered");
