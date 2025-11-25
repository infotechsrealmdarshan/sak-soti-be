import admin from "firebase-admin";
import dotenv from "dotenv";
import { successResponse, errorResponse } from "../utils/response.js";

dotenv.config();

let firebaseApp = null;

/**
 * Initialize Firebase Admin SDK from Environment Variables
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

    // Check if all required environment variables are present
    const requiredEnvVars = [
      'FIREBASE_PROJECT_ID',
      'FIREBASE_PRIVATE_KEY', 
      'FIREBASE_CLIENT_EMAIL'
    ];

    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.error("❌ Missing required Firebase environment variables:", missingVars);
      return {
        statusCode: 500,
        message: `Missing Firebase environment variables: ${missingVars.join(', ')}`,
        data: null,
      };
    }

    console.log("🔧 Initializing Firebase from environment variables...");
    console.log("📧 Client Email:", process.env.FIREBASE_CLIENT_EMAIL);
    console.log("🏢 Project ID:", process.env.FIREBASE_PROJECT_ID);

    // Fix private key formatting (replace \n with actual newlines)
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

    const serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: privateKey,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: process.env.FIREBASE_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
      token_uri: process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL || "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
      universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN || "googleapis.com"
    };

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log("✅ Firebase Admin SDK initialized successfully from environment variables");
    
    return {
      statusCode: 200,
      status: 1,
      message: "Firebase initialized successfully",
      data: { 
        source: "environment_variables",
        projectId: process.env.FIREBASE_PROJECT_ID
      },
    };

  } catch (error) {
    console.error("❌ Firebase Admin SDK initialization error:", error.message);
    
    // More detailed error logging
    if (error.message.includes("private key")) {
      console.error("🔑 Private key format issue detected");
      console.error("Private key preview:", process.env.FIREBASE_PRIVATE_KEY?.substring(0, 100));
    }
    
    return {
      statusCode: 500,
      message: `Firebase initialization failed: ${error.message}`,
      data: null,
    };
  }
};

/**
 * Verify Firebase ID Token
 */
export const verifyFirebaseToken = async (idToken) => {
  // Ensure Firebase is initialized
  if (!firebaseApp) {
    const initResult = initializeFirebase();
    if (initResult.statusCode !== 200) {
      return {
        success: false,
        message: "Firebase not initialized properly",
        error: true
      };
    }
  }

  if (!admin.apps.length) {
    return {
      success: false,
      message: "Firebase Admin SDK not initialized",
      error: true
    };
  }

  try {
    console.log("🔐 Verifying Firebase token...");
    const decoded = await admin.auth().verifyIdToken(idToken);

    console.log("✅ Firebase token verified successfully");
    console.log("📧 User email:", decoded.email);
    console.log("🆔 User UID:", decoded.uid);

    return {
      success: true,
      error: false,
      email: decoded.email,
      name: decoded.name,
      picture: decoded.picture,
      uid: decoded.uid,
      decoded,
    };
  } catch (error) {
    console.error("❌ Firebase token verification error:", error.message);
    console.error("Error code:", error.code);
    console.error("Error details:", error.details);

    let message = "Invalid Firebase token";
    
    if (error.code === "auth/id-token-expired") {
      message = "Firebase token expired";
    } else if (error.code === "auth/argument-error") {
      message = "Malformed Firebase token";
    } else if (error.code === "auth/id-token-has-wrong-audience") {
      message = "Token audience doesn't match Firebase project";
    } else if (error.code === "auth/id-token-revoked") {
      message = "Firebase token has been revoked";
    }

    return {
      success: false,
      error: true,
      message,
      code: error.code
    };
  }
};

export default { initializeFirebase, verifyFirebaseToken };