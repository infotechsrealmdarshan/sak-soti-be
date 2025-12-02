import admin from "firebase-admin";
import { initializeFirebase } from "../config/firebase.js";

initializeFirebase(); // Ensure Firebase is initialized once

/**
 * Validate FCM token format
 */
export const isValidFCMToken = (token) => {
  if (!token || typeof token !== 'string') return false;

  const cleanToken = token.trim();

  if (cleanToken.length < 140 || cleanToken.length > 200) return false;

  if (!cleanToken.includes(':')) return false;

  const placeholderPatterns = [
    /^test.*token$/i,
    /^placeholder/i,
    /^fake.*token$/i,
    /^d9Hk/i,
    /\.\.\./
  ];

  for (const pattern of placeholderPatterns) {
    if (pattern.test(cleanToken)) return false;
  }

  return true;
};

/**
 * Send a push notification using Firebase Cloud Messaging
 */
export const sendFirebaseNotification = async (fcmToken, title, body, data = {}) => {
  console.log("🔍 FCM Debug - Starting notification send");
  console.log("FCM Token received:", fcmToken);
  console.log("Token type:", typeof fcmToken);
  console.log("Token length:", fcmToken?.length);

  if (!fcmToken) {
    console.warn("⚠️ Missing FCM token — notification skipped");
    return { success: false, message: "Missing FCM token" };
  }

  // Enhanced token validation
  if (!isValidFCMToken(fcmToken)) {
    console.warn("⚠️ Skipping invalid FCM token:", fcmToken);
    return { success: false, skipped: true };
  }

  const trimmedToken = fcmToken.trim();
  console.log("✅ Token format valid, proceeding with send...");

  try {
    const payload = {
      notification: {
        title: String(title || ''),
        body: String(body || '')
      },
      data: Object.entries(data).reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key]: String(value ?? ""),
        }),
        {}
      ),
      token: trimmedToken,
    };

    console.log("📤 Attempting to send FCM payload...");
    const response = await admin.messaging().send(payload);
    console.log("✅ Firebase push sent successfully");

    return { success: true, response };
  } catch (error) {
    console.error("❌ FCM Error Details:");
    console.error("Error message:", error.message);
    console.error("Error code:", error.code);
    console.error("Error details:", error.details);

    // Handle specific FCM errors
    if (error.code === 'messaging/invalid-registration-token') {
      console.error("🔄 Token is invalid - needs to be refreshed");
    } else if (error.code === 'messaging/registration-token-not-registered') {
      console.error("🔄 Token not registered - app may be uninstalled");
    }

    return { success: false, error: error.message };
  }
};