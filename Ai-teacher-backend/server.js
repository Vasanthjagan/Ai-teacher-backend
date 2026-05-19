require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
const Groq = require("groq-sdk");

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// Import and use upload routes
const uploadroutes = require("./Route/uploadroutes");
app.use("/api", uploadroutes);

// Import and use auth routes
const authRoutes = require("./Route/authRoutes");
app.use("/api/auth", authRoutes);

// 🔊 TTS Proxy to bypass CORS for recording
app.get("/api/tts", async (req, res) => {
  try {
    const text = req.query.text;
    if (!text) return res.status(400).send("Text is required");

    // Google Translate TTS silently fails on long text — reject early
    // if (text.length > 200) {
    //   console.warn(`⚠️ TTS text too long (${text.length} chars). Split into shorter chunks first.`);
    //   return res.status(400).send("Text too long. Split into chunks of ≤200 chars.");
    // }

    const url = `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=en&q=${encodeURIComponent(text)}`;

    // Add User-Agent to satisfy Google's protection
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      }
    });

    if (!response.ok) {
      console.error(`❌ Google TTS responded with status: ${response.status}`);
      throw new Error("Failed to fetch from Google TTS");
    }

    const buffer = await response.arrayBuffer();
    console.log(`✅ [TTS] Successfully proxied: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`);

    res.set("Content-Type", "audio/mpeg");
    res.set("Access-Control-Allow-Origin", "*"); // explicitly allow for recording mix
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("❌ TTS Proxy Error:", err);
    res.status(500).send("TTS Proxy failed");
  }
});

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

// 🔒 Track rooms ended by teacher (in-memory)
const endedRooms = new Set();

const fs = require("fs");
const path = require("path");

// In-memory state for waiting and blocked students
const waitingStudents = {}; // { requestId: { name, room, status: 'waiting' | 'admitted' | 'rejected', token, url } }
const blockedStudents = new Set(); // Set of "roomName:studentName" or just globally? Let's do "roomName:studentName"
let activeVoice = "reference_voice.wav"; // Default voice

// Path to voices directory
const VOICES_DIR = path.join(__dirname, "..", "Ai-teacher-voicemodel", "voices");

// Voice Management Endpoints
app.get("/list-voices", (req, res) => {
  try {
    const rootVoices = [];
    const engineRoot = path.join(__dirname, "..", "Ai-teacher-voicemodel");

    // Check root for reference_voice.wav
    if (fs.existsSync(path.join(engineRoot, "reference_voice.wav"))) {
      rootVoices.push("reference_voice.wav");
    }

    // Check voices folder
    let subVoices = [];
    if (fs.existsSync(VOICES_DIR)) {
      subVoices = fs.readdirSync(VOICES_DIR).filter((f) => f.endsWith(".wav"));
    }

    const allVoices = Array.from(new Set([...rootVoices, ...subVoices]));
    res.json({ voices: allVoices });
  } catch (e) {
    console.error("❌ VOICES LIST ERROR:", e);
    res.status(500).json({ error: "Failed to list voices" });
  }
});

app.post("/select-voice", (req, res) => {
  const { voice } = req.body;
  if (!voice) return res.status(400).json({ error: "No voice name provided" });
  activeVoice = voice;
  console.log(`🎤 ACTIVE VOICE SET TO: ${voice}`);
  res.json({ success: true, activeVoice });
});

app.get("/active-voice", (req, res) => {
  res.json({ activeVoice });
});

const getDeviceType = (userAgent) => {
  if (/mobile/i.test(userAgent)) return "Mobile";
  if (/tablet|ipad/i.test(userAgent)) return "Tablet";
  return "Laptop";
};

app.post("/request-join", async (req, res) => {
  const { name, room } = req.body;
  if (!name || !room) {
    return res.status(400).json({ error: "Missing name or room" });
  }

  if (blockedStudents.has(`${room}:${name}`)) {
    return res
      .status(403)
      .json({ error: "You have been blocked from this room by the teacher." });
  }

  const userAgent = req.headers["user-agent"] || "";
  const deviceType = getDeviceType(userAgent);

  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  waitingStudents[requestId] = { name, room, status: "waiting", deviceType };

  console.log(`📥 JOIN REQUEST: ${name} for room ${room}. ID: ${requestId} [Device: ${deviceType}]`);
  res.json({ requestId });
});

app.get("/join-status/:requestId", (req, res) => {
  const { requestId } = req.params;
  const request = waitingStudents[requestId];

  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  res.json({
    status: request.status,
    token: request.token,
    url: request.url,
    error:
      request.status === "rejected" ? "Teacher rejected your request." : null,
  });

  // Clean up if admitted or rejected
  if (request.status === "admitted" || request.status === "rejected") {
    // We could clean up here, but let's keep it for a bit just in case of retry
    // setTimeout(() => delete waitingStudents[requestId], 60000);
  }
});

app.get("/waiting-students/:room", (req, res) => {
  const { room } = req.params;
  const list = Object.entries(waitingStudents)
    .filter(([id, req]) => req.room === room && req.status === "waiting")
    .map(([id, req]) => ({ id, name: req.name }));
  res.json({ waiting: list });
});

app.post("/admit-student", async (req, res) => {
  const { requestId } = req.body;
  const request = waitingStudents[requestId];

  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  try {
    // Generate token for the student
    const metadata = { role: "student", device: request.deviceType || "Laptop" };
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: request.name,
        metadata: JSON.stringify(metadata),
      },
    );

    at.addGrant({
      roomJoin: true,
      room: request.room,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });

    const jwt = await at.toJwt();
    request.status = "admitted";
    request.token = jwt;
    request.url = process.env.LIVEKIT_URL;

    console.log(`✅ STUDENT ADMITTED: ${request.name} to ${request.room}`);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ ADMISSION ERROR:", e);
    res.status(500).json({ error: "Failed to admit student" });
  }
});

app.post("/reject-student", (req, res) => {
  const { requestId } = req.body;
  const request = waitingStudents[requestId];
  if (request) {
    request.status = "rejected";
    console.log(`❌ STUDENT REJECTED: ${request.name} from ${request.room}`);
  }
  res.json({ success: true });
});

app.post("/remove-participant", async (req, res) => {
  const { roomName, identity, block } = req.body;
  if (!roomName || !identity) {
    return res
      .status(400)
      .json({ error: "roomName and identity are required" });
  }

  try {
    await roomService.removeParticipant(roomName, identity);
    if (block) {
      blockedStudents.add(`${roomName}:${identity}`);
      console.log(`🚫 BLOCKED: ${identity} from ${roomName}`);
    }
    console.log(`👋 REMOVED: ${identity} from ${roomName}`);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ REMOVE ERROR:", e);
    res.status(500).json({ error: "Failed to remove participant" });
  }
});

app.post("/token", async (req, res) => {
  try {
    const { name, room, role, className, topic } = req.body;
    console.log("📥 TOKEN REQUEST BODY:", req.body);

    if (!name || !room || !role) {
      return res.status(400).json({ error: "Missing name, room, or role" });
    }

    if (
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET ||
      !process.env.LIVEKIT_URL
    ) {
      return res.status(500).json({ error: "LiveKit ENV variables missing" });
    }

    // Build metadata object
    const metadata = { role };

    // Add className and topic if provided (for teachers)
    if (className) metadata.className = className;
    if (topic) metadata.topic = topic;

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: name,
        metadata: JSON.stringify(metadata),
      },
    );

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });

    const jwt = await at.toJwt();
    console.log(
      "✅ TOKEN GENERATED for:",
      name,
      "ROLE:",
      role,
      className ? `CLASS: ${className}` : "",
      topic ? `TOPIC: ${topic}` : "",
    );

    res.json({
      token: jwt,
      url: process.env.LIVEKIT_URL,
    });
  } catch (e) {
    console.error("❌ TOKEN ERROR:", e);
    res.status(500).json({ error: "Token generation failed" });
  }
});

app.post("/ask-ai", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }

    // 👋 Greeting interceptor — reply instantly without calling AI
    const greetingPattern = /^(hi|hello|hey|good morning|good afternoon|good evening|howdy|greetings|sup|yo)[!.,\s]*$/i;
    if (greetingPattern.test(question.trim())) {
      return res.json({ answer: "Hello! Please share your doubt so I can help you." });
    }

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "You are a friendly classroom Teacher. Answer student questions in SHORT, SWEET, simple English — maximum 3 lines. " +
            "RULES: " +
            "1. Give a clear, direct answer in plain English. " +
            "2. Never exceed 3 lines total. " +
            "3. Never use 'Namaste', 'Ji', or any cultural/regional words. " +
            "4. Never use filler openers like 'Great question!' or 'Of course!'. " +
            "5. Go straight to the point.",
        },
        {
          role: "user",
          content: question,
        },
      ],
      temperature: 0.4,
      max_tokens: 120,
    });

    const answer = completion.choices[0]?.message?.content;

    res.json({ answer });
  } catch (err) {
    console.error("❌ GROQ ERROR:", err);
    res.status(500).json({ error: "AI response failed" });
  }
});

// 🎤 Extract Question from Voice Transcript
app.post("/extract-question", async (req, res) => {
  try {
    const { transcript } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: "Transcript is required" });
    }

    const prompt = `You are a strict classroom assistant. 
Extract ONLY the core academic question from the transcript. 

RULES:
- If the transcript ONLY contains greetings, meta-talk (like "I have a doubt", "Wait", "One more thing"), or teacher-student chatter WITHOUT a specific subject-matter question, you MUST return exactly: <NONE>
- DO NOT extract meta-sentences like "I have one doubt" or "I have a question".
- If a question is found, return ONLY the question text clearly.
- Correct minor phonetic errors by context (e.g., if it says "What is python for", make it "What is Python for?").
- If NO specific question about the subject is found, return exactly: <NONE>

EXAMPLES:
Transcript: "Hi ma'm, I have one doubt." -> Output: <NONE>
Transcript: "Hello teacher, i have doubt what is a variable" -> Output: What is a variable?
Transcript: "Excuse me mam please explain what is inherit" -> Output: please explain what is inheritance?
Transcript: "I have one more doubt." -> Output: <NONE>

Transcript:
"${transcript}"

Extracted Question:`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "You extract core questions from classroom dialogue. Return only the extracted question text, or an empty string if none found.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.1,
    });

    const extractedQuestion = completion.choices[0]?.message?.content
      ?.trim()
      .replace(/^"|"$/g, "");

    res.json({ extractedQuestion });
  } catch (err) {
    console.error("❌ EXTRACTION ERROR:", err);
    res.status(500).json({ error: "Question extraction failed" });
  }
});

// 📝 Quiz Storage (in-memory)
const quizzes = {}; // { quizId: { roomName, topic, questions, submissions: [] } }

// 🎯 Generate Quiz
app.post("/generate-quiz", async (req, res) => {
  try {
    const { topic, studentQuestions, roomName } = req.body;

    if (!topic || !roomName) {
      return res.status(400).json({ error: "Topic and roomName are required" });
    }

    // Build context from student questions
    const questionsContext =
      studentQuestions && studentQuestions.length > 0
        ? `\n\nStudent questions during the session:\n${studentQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
        : "";

    const prompt = `You are an educational quiz generator. Generate a quiz with 5-10 multiple choice questions based on the following topic and student questions.

Topic: ${topic}${questionsContext}

Generate questions that:
1. Cover the main topic comprehensively
2. Address concepts from student questions if provided
3. Have 4 options each (A, B, C, D)
4. Have exactly one correct answer
5. Are educational and appropriate

Return ONLY a valid JSON array in this exact format, with no additional text:
[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0
  }
]

The correctAnswer should be the index (0-3) of the correct option.`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "You are a quiz generator. Return only valid JSON arrays with no additional text or formatting.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.7,
    });

    let quizQuestions;
    try {
      const responseText = completion.choices[0]?.message?.content.trim();
      // Remove markdown code blocks if present
      const jsonText = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      quizQuestions = JSON.parse(jsonText);

      if (!Array.isArray(quizQuestions)) {
        throw new Error("AI did not return a JSON array");
      }
    } catch (parseError) {
      console.error("❌ JSON Parse Error:", parseError);
      return res
        .status(500)
        .json({
          error: "Failed to parse quiz questions or AI returned invalid format",
        });
    }

    // Generate unique quiz ID
    const quizId = `quiz_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store quiz
    quizzes[quizId] = {
      roomName,
      topic,
      questions: quizQuestions,
      submissions: [],
      createdAt: new Date().toISOString(),
    };

    console.log(`✅ Quiz generated: ${quizId} for room: ${roomName}`);

    res.json({
      quizId,
      questions: quizQuestions.map((q, idx) => ({
        id: idx,
        question: q.question,
        options: q.options,
      })),
    });
  } catch (err) {
    console.error("❌ QUIZ GENERATION ERROR:", err);
    res.status(500).json({ error: "Quiz generation failed" });
  }
});

// 📤 Submit Quiz
app.post("/submit-quiz", async (req, res) => {
  try {
    const { quizId, studentName, answers } = req.body;

    if (!quizId || !studentName || !answers) {
      return res
        .status(400)
        .json({ error: "quizId, studentName, and answers are required" });
    }

    const quiz = quizzes[quizId];
    if (!quiz) {
      return res.status(404).json({ error: "Quiz not found" });
    }

    // Grade the quiz
    let correctCount = 0;
    const results = quiz.questions.map((q, idx) => {
      const studentAnswer = answers[idx];
      const isCorrect = studentAnswer === q.correctAnswer;
      if (isCorrect) correctCount++;

      return {
        questionId: idx,
        question: q.question,
        studentAnswer,
        correctAnswer: q.correctAnswer,
        isCorrect,
      };
    });

    const score = Math.round((correctCount / quiz.questions.length) * 100);

    // Store submission
    const submission = {
      studentName,
      answers,
      score,
      correctCount,
      totalQuestions: quiz.questions.length,
      submittedAt: new Date().toISOString(),
      video_activity: req.body.video_activity || "N/A",
      status: req.body.status || "Good",
      reason: req.body.reason || "None",
      browserSwitchCount: req.body.browserSwitchCount || 0,
    };

    quiz.submissions.push(submission);

    console.log(`✅ Quiz submitted by ${studentName}: ${score}%`);

    res.json({
      score,
      correctCount,
      totalQuestions: quiz.questions.length,
      results,
    });
  } catch (err) {
    console.error("❌ QUIZ SUBMISSION ERROR:", err);
    res.status(500).json({ error: "Quiz submission failed" });
  }
});

// 📊 Get Quiz Results (Teacher)
app.get("/quiz-results/:quizId", (req, res) => {
  try {
    const { quizId } = req.params;

    const quiz = quizzes[quizId];
    if (!quiz) {
      return res.status(404).json({ error: "Quiz not found" });
    }

    // Calculate statistics
    const scores = quiz.submissions.map((s) => s.score);
    const stats = {
      totalSubmissions: quiz.submissions.length,
      averageScore:
        scores.length > 0
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : 0,
      highestScore: scores.length > 0 ? Math.max(...scores) : 0,
      lowestScore: scores.length > 0 ? Math.min(...scores) : 0,
    };

    res.json({
      quizId,
      topic: quiz.topic,
      roomName: quiz.roomName,
      createdAt: quiz.createdAt,
      questions: quiz.questions,
      submissions: quiz.submissions,
      stats,
    });
  } catch (err) {
    console.error("❌ QUIZ RESULTS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch quiz results" });
  }
});

// 🚪 End Meeting (Delete Room)
app.post("/end-room", async (req, res) => {
  try {
    const { roomName } = req.body;
    if (!roomName) {
      return res.status(400).json({ error: "roomName is required" });
    }

    await roomService.deleteRoom(roomName);
    endedRooms.add(roomName); // 🔒 Mark room as ended
    console.log(`🗑️ Room ${roomName} has been ended by teacher.`);
    res.json({ success: true, message: `Room ${roomName} ended.` });
  } catch (e) {
    // Even if deleteRoom fails (room already gone), mark it as ended
    if (req.body.roomName) endedRooms.add(req.body.roomName);
    console.error("❌ END ROOM ERROR:", e);
    res.status(500).json({ error: "Failed to end room" });
  }
});

// 🔍 Check Room Status (for student join page)
app.get("/room-status/:roomName", (req, res) => {
  const { roomName } = req.params;
  const ended = endedRooms.has(roomName);
  console.log(
    `🔍 Room status check: ${roomName} → ${ended ? "ENDED" : "ACTIVE"}`,
  );
  res.json({ ended });
});

// 🌟 Encourage Student
app.post("/encourage-student", async (req, res) => {
  try {
    const { name, question } = req.body;

    if (!name || !question) {
      return res.status(400).json({ error: "Name and question are required" });
    }

    const prompt = `You are an encouraging Indian Teacher's Assistant. A student named "${name}" just asked this academic doubt: "${question}".
    Provide a very short, one-sentence encouraging response.
    Examples: "That is a very good curiosity, ${name}!", "Great doubt, ${name}, let's clear it together.", "Interesting point, ${name} - keep it up!"
    
    RULES:
    1. Keep it under 15 words.
    2. Be polite and use the student's name.
    3. Use "doubt" instead of "question" where appropriate.
    4. Return ONLY the encouraging statement.`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "You are an Indian Teacher Assistant providing short, polite, and encouraging feedback.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.8,
    });

    const encouragement =
      completion.choices[0]?.message?.content.trim() ||
      `Good question, ${name}!`;

    res.json({ encouragement });
  } catch (err) {
    console.error("❌ ENCOURAGEMENT ERROR:", err);
    res.status(500).json({ error: "Encouragement failed" });
  }
});

// 📝 Generate Class Summary
app.post("/generate-summary", async (req, res) => {
  try {
    const { topic, studentQuestions } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    const questionsContext =
      studentQuestions && studentQuestions.length > 0
        ? `\n\nStudent doubts cleared during the session:\n${studentQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
        : "";

    const prompt = `You are an Indian Teacher Assistant. Provide a concise summary of the class based on the topic and doubts cleared.
    
Topic: ${topic}${questionsContext}

Rules:
1. Keep the summary under 50 words.
2. Highlight the key concepts discussed.
3. Use a polite, professional Indian academic tone.
4. Use terms like "doubts cleared" instead of "questions answered".
5. Return ONLY the summary text.`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "You are an Indian Teacher Assistant. Provide concise and polite class summaries.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.5,
    });

    const summary =
      completion.choices[0]?.message?.content.trim() || "No summary available.";

    res.json({ summary });
  } catch (err) {
    console.error("❌ SUMMARY GENERATION ERROR:", err);
    res.status(500).json({ error: "Summary generation failed" });
  }
});

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
