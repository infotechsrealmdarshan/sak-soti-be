import { createClient } from "redis";

const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  },
  // Disable Redis persistence to avoid disk write errors
  disableOfflineQueue: true,
});

redisClient.on("connect", () => console.log("✅ Redis connected"));
redisClient.on("error", (err) => {
  console.warn("⚠️ Redis error (non-critical):", err.message);
});

// Try to connect to Redis, but don't fail the app if Redis is unavailable
try {
  await redisClient.connect();
  // Disable Redis persistence to prevent disk write errors
  await redisClient.configSet('stop-writes-on-bgsave-error', 'no');
  await redisClient.configSet('save', '');
} catch (error) {
  console.warn("⚠️ Redis connection failed (app will work without caching):", error.message);
}

export default redisClient;
