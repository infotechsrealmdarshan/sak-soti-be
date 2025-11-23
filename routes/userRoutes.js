import express from "express";
import auth from "../middlewares/auth.js";
import {
  registerUser,
  loginUser,
  getProfile,
  updateProfile,
  forgotPassword,
  resetPassword,
  updateStatus,
  googleAuth,
  logoutUser,
  refreshToken,
  bulkDeleteUsers,
  deleteMyAccount,
} from "../controller/userController.js";
import { uploadMedia } from "../middlewares/uploadMedia.js";
import { adminOnly } from "../middlewares/role.js";


const router = express.Router();

// ---------------- USER ROUTES ----------------

/**
 * @swagger
 * /api/users/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firstname
 *               - lastname
 *               - email
 *               - password
 *             properties:
 *               firstname:
 *                 type: string
 *                 example: John
 *               lastname:
 *                 type: string
 *                 example: Doe
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john.doe@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: Test@123
 *               profileimg:
 *                 type: string
 *                 example: https://example.com/profile.jpg
 *                 description: Optional profile image URL
 *               fcmToken:
 *                 type: string
 *                 description: Optional Firebase Cloud Messaging token for push notifications
 *                 example: d9Hk...YourDeviceFcmToken
 *               country:
 *                 type: string
 *                 description: Optional country name
 *                 example: United States
 *     responses:
 *       200:
 *         description: User registered successfully (status 1) or Registration failed - validation error (status 0)
 */
router.post("/register", uploadMedia(["image"], 0, {}).single("profileimg"), registerUser);

/**
 * @swagger
 * /api/users/login:
 *   post:
 *     summary: Login user
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john.doe@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: Test@123
 *               fcmToken:
 *                 type: string
 *                 description: Optional Firebase Cloud Messaging token for push notifications
 *                 example: d9Hk...YourDeviceFcmToken
 *     responses:
 *       200:
 *         description: Login successful (status 1) or Invalid credentials/User not found (status 0)
 */
router.post("/login", loginUser);

/**
 * @swagger
 * /api/users/me:
 *   get:
 *     summary: Get current user profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully (status 1) or User not found (status 0)
 *       404:
 *         description: API logic issue - token missing or invalid
 */
router.get("/me", auth, getProfile);

/**
 * @swagger
 * /api/users/update:
 *   put:
 *     summary: Update user profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstname:
 *                 type: string
 *                 example: John
 *               lastname:
 *                 type: string
 *                 example: Doe
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john.doe@example.com
 *               profileimg:
 *                 type: string
 *                 example: https://example.com/profile.jpg
 *               country:
 *                 type: string
 *                 description: Optional country name
 *                 example: United States
 *     responses:
 *       200:
 *         description: Profile updated successfully (status 1) or User not found (status 0)
 *       404:
 *         description: API logic issue - token missing or invalid
 */
router.put("/update", auth, uploadMedia(["image"], 0, {}).single("profileimg"), updateProfile);

/**
 * @swagger
 * /api/users/forgot-password:
 *   post:
 *     summary: Request password reset
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john.doe@example.com
 *     responses:
 *       200:
 *         description: Password reset email sent
 *       404:
 *         description: User not found
 */
router.post("/forgot-password", forgotPassword);

/**
 * @swagger
 * /api/users/reset-password:
 *   post:
 *     summary: Reset password using token
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - newPassword
 *             properties:
 *               token:
 *                 type: string
 *                 example: reset-token-here
 *               newPassword:
 *                 type: string
 *                 format: password
 *                 example: NewPassword123@!
 *     responses:
 *       200:
 *         description: Password reset successfully (status 1) or validation failed (status 0)
 */
router.post("/reset-password", resetPassword);

/**
 * @swagger
 * /api/users/google-login:
 *   post:
 *     summary: Google Authentication (Login or Register)
 *     description: Authenticate user using Firebase ID token from Google Sign-In. Automatically registers new users or logs in existing users. Saves Google profile picture to database. Stores Firebase token in database (nullable field).
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - idToken
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Firebase ID token received from Google Sign-In on frontend
 *                 example: eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1NiIsInR5cCI6IkpXVCJ9...
 *     responses:
 *       200:
 *         description: Google login successful (status 1) or Authentication failed (status 0). Returns accessToken, refreshToken, and user object with profile picture saved from Google.
 *       500:
 *         description: Server configuration error
 */
router.post("/google-login", googleAuth);

/**
 * @swagger
 * /api/users/status:
 *   put:
 *     summary: Update user status
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, inactive]
 *                 example: active
 *     responses:
 *       200:
 *         description: Status updated successfully (status 1) or User not found (status 0)
 *       404:
 *         description: API logic issue - token missing or invalid
 */
router.put("/status", auth, updateStatus);

/**
 * @swagger
 * /api/users/refresh:
 *   post:
 *     summary: Refresh access token using refresh token
 *     description: Generate a new access token using a valid refresh token. The refresh token must be valid and stored in the system.
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *                 description: Refresh token received during login
 *                 example: eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1NiIsInR5cCI6IkpXVCJ9...
 *     responses:
 *       200:
 *         description: New access token generated successfully (status 1)
 *       404:
 *         description: Invalid or expired refresh token
 */
router.post("/refresh", refreshToken);

/**
 * @swagger
 * /api/users/logout:
 *   post:
 *     summary: Logout user and invalidate refresh token
 *     description: This API logs out the user by removing the refresh token from the server or database.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successfully logged out
 *       404:
 *         description: API logic issue - token missing or invalid
 */
router.post("/logout", auth, logoutUser);

/**
 * @swagger
 * /api/users/bulk-delete:
 *   delete:
 *     summary: Bulk delete users (Admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userIds
 *             properties:
 *               userIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: objectid
 *                 example: ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
 *                 description: Array of user IDs to delete
 *     responses:
 *       200:
 *         description: Users deleted successfully
 *       400:
 *         description: Invalid input
 */
router.delete("/bulk-delete", auth, adminOnly, bulkDeleteUsers); 

/**
 * @swagger
 * /api/users/delete-account:
 *   delete:
 *     summary: Soft delete (deactivate) your own account
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Account soft-deleted successfully (status 1)
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       404:
 *         description: User not found
 */
router.delete("/delete-account", auth, deleteMyAccount);


export default router;
