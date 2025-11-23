import express from "express";
import { createNotification, getUserNotifications, markNotificationAsRead } from "../controller/notificationController.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Notification
 *   description: Notification management APIs
 */

/**
 * @swagger
 * /api/notification:
 *   post:
 *     summary: Create and send a new notification
 *     description: Save notification to DB and send push notification via Firebase using the provided FCM token.
 *     tags: [Notification]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - title
 *               - message
 *             properties:
 *               userId:
 *                 type: string
 *                 example: "672fffa5b1d9f30c5b82b0e4"
 *               title:
 *                 type: string
 *                 example: "New Reward Unlocked"
 *               message:
 *                 type: string
 *                 example: "Congrats! You just unlocked a new badge."
 *               deeplink:
 *                 type: string
 *                 example: "app://rewards"
 *               fcmToken:
 *                 type: string
 *                 example: "f8hQXGyTQzv4...K3mGPo"
 *     responses:
 *       200:
 *         description: Notification created & sent successfully
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Internal server error
 */
router.post("/", auth, createNotification);

/**
 * @swagger
 * /api/notification:
 *   get:
 *     summary: Get all notifications for the logged-in user
 *     tags: [Notification]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Notifications fetched successfully
 */
router.get("/", auth, getUserNotifications);

/**
 * @swagger
 * /api/notification/{id}/read:
 *   patch:
 *     tags: [Notification]
 *     summary: Mark a notification as read
 *     description: Marks a specific notification as read using its ID.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: Notification ID
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Notification marked as read successfully
 *       404:
 *         description: Notification not found
 *       500:
 *         description: Internal server error
 */
router.patch("/:id/read", auth, markNotificationAsRead);


export default router;
