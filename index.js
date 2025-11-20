import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import connectDB from "./config/db.js";
import { specs, swaggerUi } from "./config/swagger.js";
import { initializeFirebase } from "./config/firebase.js";
import { initializeSocket } from "./config/socket.js";
import { globalErrorHandler } from "./utils/errorHandler.js";
import userRoutes from "./routes/userRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import newsRoutes from "./routes/newsRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
// import { checkExpiredSubscriptions } from "./utils/subscriptionCron.js";
import policyRoutes from "./routes/policyRoutes.js"
import termRoutes from "./routes/termRoutes.js"
import contactRoutes from "./routes/contactRoutes.js"
import notificationRoutes from "./routes/notificationRoutes.js";
import stripeRoutes from "./routes/stripeRoutes.js";
import { stripeWebhook } from "./controller/stripeController.js";

dotenv.config();
const app = express();

// ✅ CORS config
const corsOptions = {
  origin: process.env.FRONTEND_URL || "*",
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
// Note: Stripe webhook requires raw body for signature verification.
// We mount the webhook route with express.raw BEFORE express.json.

app.post(
  "/api/subscription/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhook
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static("uploads"));

// ✅ DB + Firebase
connectDB();
initializeFirebase();

// ✅ Swagger UI setup
const swaggerUiOptions = {
  swaggerOptions: {
    tagsSorter: (a, b) => {
      const order = ["Users", "Admin", "News", "Posts", "Chat", "Transaction", "Upload"];
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    },
    operationsSorter: "alpha",
    docExpansion: "none",
    filter: true,
    showRequestHeaders: true,
    showCommonExtensions: true,
    tryItOutEnabled: true,
  },
};

// ✅ Routes
app.get("/api", (req, res) => {
  res.json({
    message: "SAK SOTI Backend API",
    version: "1.0.0",
    documentation: "https://sak-soti-backend.vercel.app/api-docs",
  });
});

app.get("/api-docs.json", (req, res) => {
  res.json(specs);
});

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs, swaggerUiOptions));

app.use("/api/users", userRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/news", newsRoutes);
app.use("/api/post", postRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/policy", policyRoutes);
app.use("/api/terms", termRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/notification", notificationRoutes);
app.use("/api/subscription", stripeRoutes);

// ✅ Subscription cron (disabled on Vercel)
// if (process.env.VERCEL !== "1") {
//   setInterval(async () => {
//     await checkExpiredSubscriptions();
//   }, 15 * 60 * 1000);
//   checkExpiredSubscriptions().catch(console.error);
// }

// ✅ Global error handler
app.use(globalErrorHandler);

// ✅ Create HTTP server for Socket.IO
const server = createServer(app);

// ✅ Initialize Socket.IO with HTTP server
initializeSocket(server);

// ✅ Start server (only if not on Vercel)
if (process.env.VERCEL !== "1") {
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔌 Socket.IO ready for real-time connections`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} is already in use!\n`);
      console.error(`Solutions:`);
      console.error(`  1. Kill the process: taskkill /PID <PID> /F`);
      console.error(`  2. Find process: netstat -ano | findstr :${PORT}`);
      console.error(`  3. Use different port: $env:PORT=3002; node index.js\n`);
    } else {
      console.error('❌ Server error:', err);
    }
    process.exit(1);
  });
}

// ✅ Export app for Vercel (and server for local development)
export default app;
export { server };