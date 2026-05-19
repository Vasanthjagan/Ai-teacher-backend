const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const Groq = require("groq-sdk");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

const router = express.Router();

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const roomName = req.body.roomName || "DefaultRoom";
        const className = req.body.className || roomName;
        const today = new Date().toISOString().split("T")[0];

        const basePath = path.join(
            __dirname,
            "..",
            "ClassRecordings",
            today,
            className
        );

        if (!fs.existsSync(basePath)) {
            fs.mkdirSync(basePath, { recursive: true });
        }

        cb(null, basePath);
    },

    filename: function (req, file, cb) {
        const partNumber = req.body.partNumber || "1";
        const sessionId = req.body.sessionId || Date.now();
        cb(null, `${sessionId}_Part_${partNumber}.webm`);
    }
});

const upload = multer({ storage });

router.post("/upload", upload.single("video"), async (req, res) => {
    const { roomName, className, partNumber, sessionId, transcribe, isFinal, chatHistory } = req.body;
    const filePath = req.file.path;
    const directory = path.dirname(filePath);

    console.log(`📥 Received Part ${partNumber} for session ${sessionId}. Final: ${isFinal}, Transcribe: ${transcribe}`);

    // If chat history is provided, save it for the summary phase
    if (chatHistory) {
        const chatPath = path.join(directory, `${sessionId}_chat.json`);
        fs.writeFileSync(chatPath, chatHistory);
        console.log(`💬 Chat history saved for session ${sessionId}`);
    }

    if (isFinal === "true" && transcribe === "true") {
        console.log(`🎬 Recording finished. Starting transcription process for session ${sessionId}...`);

        setImmediate(async () => {
            try {
                await processTranscription(directory, sessionId, className || roomName);
            } catch (err) {
                console.error("❌ Transcription Process Error:", err);
            }
        });
    }

    res.json({
        message: "Uploaded successfully",
        filePath: filePath
    });
});

async function processTranscription(directory, sessionId, className) {
    const files = fs.readdirSync(directory)
        .filter(f => f.startsWith(sessionId) && f.endsWith(".webm"))
        .sort((a, b) => {
            const partA = parseInt(a.split("_Part_")[1]);
            const partB = parseInt(b.split("_Part_")[1]);
            return partA - partB;
        });

    if (files.length === 0) return;

    const listFilePath = path.join(directory, `${sessionId}_list.txt`);
    const listContent = files.map(f => `file '${f}'`).join("\n");
    fs.writeFileSync(listFilePath, listContent);

    const mergedVideoPath = path.join(directory, `${sessionId}_merged.webm`);
    const audioPath = path.join(directory, `${sessionId}_audio.mp3`);

    console.log(`🔗 Merging ${files.length} parts...`);
    await execPromise(`ffmpeg -f concat -safe 0 -i "${listFilePath}" -c copy "${mergedVideoPath}"`);

    console.log(`🎵 Extracting audio...`);
    await execPromise(`ffmpeg -i "${mergedVideoPath}" -vn -ab 128k -ar 44100 -y "${audioPath}"`);

    console.log(`📝 Sending to Groq for transcription...`);
    const audioTranscription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: "whisper-large-v3",
        response_format: "text",
    });

    // 📖 Combine with Chat History
    let fullTranscript = `--- SPOKEN AUDIO TRANSCRIPT ---\n${audioTranscription}\n\n`;

    const chatPath = path.join(directory, `${sessionId}_chat.json`);
    if (fs.existsSync(chatPath)) {
        try {
            const chatData = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
            fullTranscript += `--- TEXT CHAT & QA HISTORY ---\n`;
            chatData.forEach(msg => {
                fullTranscript += `[${msg.name}]: ${msg.text}\n`;
                if (msg.answer) fullTranscript += `[AI Answer]: ${msg.answer}\n`;
            });
            fs.unlinkSync(chatPath); // Cleanup
        } catch (e) {
            console.warn("⚠️ Failed to parse chat history:", e.message);
        }
    }

    const transcriptionPath = path.join(directory, "transcription.txt");
    fs.writeFileSync(transcriptionPath, fullTranscript);
    console.log(`✅ Final transcription/chat log saved to ${transcriptionPath}`);

    console.log(`🤖 Generating summary...`);
    const completion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
            {
                role: "system",
                content: "You are an AI assistant helping a teacher. Summarize the following meeting content (Transcript AND Chat) into key points and action items. IMPORTANT: Use PLAIN TEXT ONLY. Do NOT use markdown bolding (like **text**), italics, or other markdown symbols. Do NOT include a 'Student Questions and Answers' section. Use standard numbering (1., 2., etc.) for lists."
            },
            {
                role: "user",
                content: fullTranscript
            }
        ],
    });

    const summary = completion.choices[0]?.message?.content || "No summary generated.";
    const summaryPath = path.join(directory, "summary.txt");
    fs.writeFileSync(summaryPath, summary);
    console.log(`✅ Summary saved to ${summaryPath}`);

    // Append summary to the full transcript
    fullTranscript += `\n--- CLASS SUMMARY ---\n${summary}\n`;
    fs.writeFileSync(transcriptionPath, fullTranscript);
    console.log(`✅ Class Summary appended to ${transcriptionPath}`);

    try {
        fs.unlinkSync(listFilePath);
        fs.unlinkSync(audioPath);
    } catch (e) { }
}

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

module.exports = router;
