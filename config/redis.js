// import Redis from "ioredis";

// let redisClient;

// // Prefer REDIS_URL in production (Upstash, Render, Railway, etc)
// if (process.env.REDIS_URL) {
//   redisClient = new Redis(process.env.REDIS_URL, {
//     retryStrategy(times) {
//       return Math.min(times * 100, 2000);
//     },
//   });

//   logger.log("Using REDIS_URL for Redis connection");
// } else {
//   // Local Redis config
//   redisClient = new Redis({
//     host: process.env.REDIS_HOST || "127.0.0.1",
//     port: process.env.REDIS_PORT || 6379,
//     password: process.env.REDIS_PASSWORD,
//     username: process.env.REDIS_USERNAME,
//     retryStrategy(times) {
//       return Math.min(times * 100, 2000);
//     },
//   });

//   logger.log("Using host/port config for Redis connection");
// }

// // Events
// redisClient.on("connect", () => {
//   logger.log("✅ Redis Client Connected");
// });

// redisClient.on("error", (err) => {
//   logger.error("❌ Redis Client Error:", err);
// });

// // Add correct setEx function for ioredis
// redisClient.setEx = async function (key, seconds, value) {
//   return this.set(key, value, "EX", seconds);
// };

// export default redisClient;

import Redis from "ioredis";
import logger from "../utils/logger.js";

let redisClient;

try {
  redisClient = new Redis(process.env.REDIS_URL, {
    tls: {},                          // Required for Upstash
    maxRetriesPerRequest: null,       // ❗ MUST BE DISABLED FOR UPSTASH
    enableReadyCheck: false,          // ❗ IMPORTANT (Upstash doesn’t support ready check)
    connectTimeout: 15000,
    retryStrategy(times) {
      return Math.min(times * 200, 5000);
    }
  });
} catch (err) {
  logger.error("❌ Failed to initialize Redis:", err);
}

// Events
redisClient.on("connect", () => {
  logger.log("✅ Redis connected to Upstash");
});

redisClient.on("error", (err) => {
  logger.error("❌ Redis error:", err.message);
});

// Add setEx manually
redisClient.setEx = async function (key, seconds, value) {
  return this.set(key, value, "EX", seconds);
};

export default redisClient;
