import admin from "firebase-admin";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { successResponse, errorResponse } from "../utils/response.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let firebaseApp = null;

/**
 * Initialize Firebase Admin SDK
 * Supports multiple configuration methods
 */
export const initializeFirebase = () => {
  try {
    // Already initialized
    if (admin.apps.length > 0) {
      firebaseApp = admin.app();
      console.log("✅ Firebase Admin SDK already initialized");
      return {
        statusCode: 200,
        status: 1,
        message: "Firebase already initialized",
        data: { initialized: true },
      };
    }

    // Option 1: Load from JSON file
    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      try {
        const envPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH.trim();
        const isAbsolutePath =
          envPath.startsWith("/") ||
          (process.platform === "win32" && /^[A-Za-z]:/.test(envPath));

        const serviceAccountPath = isAbsolutePath
          ? envPath
          : join(__dirname, "..", envPath);

        const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
        firebaseApp = admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });

        console.log(`✅ Firebase Admin SDK initialized from file: ${serviceAccountPath}`);
        return {
          statusCode: 200,
          status: 1,
          message: "Firebase initialized from service account file",
          data: { source: "file", path: serviceAccountPath },
        };
      } catch (error) {
        console.error("❌ Error reading Firebase service account file:", error.message);
      }
    }

    // Option 2: Use environment variables
    if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_PRIVATE_KEY &&
      process.env.FIREBASE_CLIENT_EMAIL
    ) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
      });

      console.log("✅ Firebase Admin SDK initialized with environment variables");
      return {
        statusCode: 200,
        status: 1,
        message: "Firebase initialized from environment variables",
        data: { source: "env" },
      };
    }

    // Option 3: Use JSON string in env
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        firebaseApp = admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });

        console.log("✅ Firebase Admin SDK initialized from JSON string");
        return {
          statusCode: 200,
          status: 1,
          message: "Firebase initialized from JSON string",
          data: { source: "json_string" },
        };
      } catch (error) {
        console.error("❌ Error parsing FIREBASE_SERVICE_ACCOUNT_JSON:", error.message);
      }
    }

    // No valid configuration found
    console.warn("⚠️ Firebase Admin SDK not configured properly.");
    return {
      statusCode: 401,
      message:
        "Firebase configuration missing. Please set FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_PROJECT_ID, or FIREBASE_SERVICE_ACCOUNT_JSON.",
      data: null,
    };
  } catch (error) {
    console.error("❌ Firebase Admin SDK initialization error:", error.message);
    return {
      statusCode: 500,
      message: "Firebase initialization failed",
      data: null,
    };
  }
};

/**
 * Verify Firebase ID Token
 * Returns unified structured response
 */
export const verifyFirebaseToken = async (idToken) => {
  if (!firebaseApp) {
    initializeFirebase();
  }

  if (!admin.apps.length) {
    return {
      statusCode: 500,
      message: "Firebase Admin SDK not initialized",
      data: null,
    };
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return {
      statusCode: 200,
      status: 1,
      message: "Firebase token verified successfully",
      data: {
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
        decoded,
      },
    };
  } catch (error) {
    console.error("❌ Firebase token verification error:", error.message);

    let message = "Invalid Firebase token";
    let statusCode = 401;

    if (error.code === "auth/id-token-expired") {
      message = "Firebase token expired";
      statusCode = 401;
    }

    return {
      statusCode,
      message,
      data: null,
    };
  }
};

export default { initializeFirebase, verifyFirebaseToken };
