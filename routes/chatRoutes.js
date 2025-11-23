import express from "express";
import auth from "../middlewares/auth.js";
import subscriptionRequired from "../middlewares/subscription.js";
import { uploadMedia, uploadLimitErrorHandler } from "../middlewares/uploadMedia.js";
import { actOnChatRequest, getRequestsByType, sendChatRequest } from "../controller/chatController/chatRequestController.js";
import { createGroupViaJson, deleteGroupByCreator, updateGroupByCreator, updateGroupProfileByCreator } from "../controller/chatController/groupController.js";
import { getChatMessages, sendChatMessage, uploadChatMedia } from "../controller/chatController/chatController.js";
import { deleteChatMessagesBulk, editMessage } from "../controller/chatController/updateChatController.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   - name: Chat
 *     description: Individual chat & group chat requests and messaging
 */

/**
 * @swagger
 * /api/chat/request:
 *   post:
 *     tags: [Chat]
 *     summary: Send chat request (private or group)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [postId]
 *             properties:
 *               postId:
 *                 type: string
 *                 description: ID of the target post; receiver inferred from post author
 *               
 *     responses:
 *       200:
 *         description: Chat request sent
 *       404:
 *         description: API logic issue - token missing or invalid
 */
router.post("/request", auth, subscriptionRequired, sendChatRequest);

/**
 * @swagger
 * /api/chat/requests:
 *   get:
 *     tags: [Chat]
 *     summary: Get requests by type (received | sent | accepted)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [received, sent, accepted, group]
 *         description: Which list to fetch (group lists pending group requests for me)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search query to filter by sender/receiver name, email, or group name
 *     responses:
 *       200:
 *         description: Requests for the given type with pagination (status 1) or Invalid type (status 0)
 */
router.get("/requests", auth, subscriptionRequired, getRequestsByType);

/**
 * @swagger
 * /api/chat/request/{id}:
 *   put:
 *     tags: [Chat]
 *     summary: Accept or reject a chat request
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [accept, reject]
 *     responses:
 *       200:
 *         description: Request handled (accepted or rejected) (status 1) or Invalid input/Request not found (status 0)
 *       404:
 *         description: API logic issue
 */
router.put("/request/:id", auth, subscriptionRequired, actOnChatRequest);

/**
 * @swagger
 * /api/chat/{chatId}/message:
 *   post:
 *     tags: [Chat]
 *     summary: Send a message in an individual chat (between sender and receiver only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message:
 *                 type: string
 *                 description: Text message
 *     responses:
 *       200:
 *         description: Message sent (status 1)
 */
// Unified message endpoint for individual and group
router.post("/:chatId/message", auth, subscriptionRequired, sendChatMessage);

/**
 * @swagger
 * /api/chat/{chatId}/media:
 *   post:
 *     tags: [Chat]
 *     summary: Upload a media message (image, video, or audio) to a chat
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Image (jpg/png), video (mp4/mov/avi/mkv), audio (mp3/wav/aac/m4a/ogg), or PDF (pdf)
 *     responses:
 *       200:
 *         description: Media message sent (status 1)
 *       404:
 *         description: API logic issue - token missing or invalid
 */
// Unified media upload: image (10MB), video (50MB), audio (20MB), pdf (10MB via override per route)
router.post(
	"/:chatId/media",
	auth,
	subscriptionRequired,
	// Per-type limits via env: IMAGE_MAX_MB, VIDEO_MAX_MB, AUDIO_MAX_MB, PDF_MAX_MB
	uploadMedia(["image", "video", "audio", "pdf"], 0, {}).single("file"),
	uploadChatMedia,
	uploadLimitErrorHandler
);

/**
 * @swagger
 * /api/chat/{chatId}:
 *   get:
 *     tags: [Chat]
 *     summary: Get individual chat with messages for the two participants
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of messages per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search query to filter messages by content
 *     responses:
 *       200:
 *         description: Chat messages fetched with pagination
 */
router.get("/:chatId", auth, subscriptionRequired, getChatMessages);

/**
 * @swagger
 * /api/chat/{chatId}/messages:
 *   delete:
 *     tags: [Chat]
 *     summary: Bulk delete messages with smart permission handling
 *     description: |
 *       Smart deletion logic:
 *       - When deleting ONLY your own messages: You can choose 'me' (delete only for you) or 'everyone' (delete for all participants)
 *       - When deleting received messages or mixed messages: Only 'me' option is allowed (delete only for you)
 *       - 'deleteFor everyone' is only available when ALL selected messages are your own
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID (individual or group)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messageIds, deleteFor]
 *             properties:
 *               messageIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of message IDs to delete
 *               deleteFor:
 *                 type: string
 *                 enum: [me, everyone]
 *                 description: |
 *                   - 'me': Delete messages only for current user (works for any messages)
 *                   - 'everyone': Delete messages for all participants (only works for YOUR OWN messages)
 *     responses:
 *       200:
 *         description: Messages deleted successfully
 *       400:
 *         description: |
 *           - Invalid input or message IDs
 *           - Trying to delete received messages with 'everyone' option
 *           - Trying to delete mixed messages with 'everyone' option
 *       403:
 *         description: Permission denied (trying to delete others' messages for everyone)
 */
router.delete("/:chatId/messages", auth, subscriptionRequired, deleteChatMessagesBulk);

// removed eligible-users endpoint
/**
 * @swagger
 * /api/chat/group:
 *   post:
 *     tags: [Chat]
 *     summary: Create a group by providing member IDs (multipart/form-data)
 *     description: Accepts multipart/form-data with optional group name, memberIds array, and optional group image
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [memberIds]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Optional group name
 *               memberIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of user IDs to add (required, send as JSON string or multiple fields)
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: Optional group profile image (jpg/png)
 *     responses:
 *       200:
 *         description: Group created (status 1)
 *       404:
 *         description: API logic issue - token missing or invalid
 */
router.post(
	"/group",
	auth,
	subscriptionRequired,
	uploadMedia(["image"], 0, {}).single("image"),
	createGroupViaJson,
	uploadLimitErrorHandler
);

/**
 * @swagger
 * /api/chat/{chatId}/message/{messageId}:
 *   put:
 *     tags: [Chat]
 *     summary: Edit a message (user can only edit their own messages)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID (individual or group) - this is chatRequestId for conversations or group _id for group chats
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *         description: Message ID to edit
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *                 description: Updated message content
 *     responses:
 *       200:
 *         description: Message edited successfully
 *       400:
 *         description: Invalid input or empty message
 *       403:
 *         description: Permission denied - user can only edit their own messages
 *       404:
 *         description: Message not found
 */
router.put("/:chatId/message/:messageId", auth, subscriptionRequired, editMessage);

/**
 * @swagger
 * /api/chat/group:
 *   put:
 *     tags: [Chat]
 *     summary: Update group (creator only) - add/remove members
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [groupId, type, memberIds]
 *             properties:
 *               groupId:
 *                 type: string
 *                 description: Target group ID
 *               type:
 *                 type: string
 *                 enum: [add, remove]
 *               memberIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Group updated
 *       404:
 *         description: API logic issue - token missing or invalid / Group not found
 */
router.put("/group", auth, subscriptionRequired, updateGroupByCreator);

/**
 * @swagger
 * /api/chat/group/{id}:
 *   delete:
 *     tags: [Chat]
 *     summary: Delete group (creator only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Group deleted
 *       404:
 *         description: API logic issue - token missing or invalid / Group not found
 */
router.delete("/group/:id", auth, subscriptionRequired, deleteGroupByCreator);

/**
 * @swagger
 * /api/chat/group/profile:
 *   put:
 *     tags: [Chat]
 *     summary: Update group profile (any group member, except admins) - name and/or image
 *     description: "Accepts application/json with optional name and image URL, or multipart/form-data for file upload. Any group member (creator, admin, or member) can update the profile, except users with isAdmin: true (they can only view). Updates all group members via socket notifications."
 *     operationId: updateGroupProfile
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [groupId]
 *             properties:
 *               groupId:
 *                 type: string
 *                 description: Target group ID (required)
 *               name:
 *                 type: string
 *                 description: Optional new group name
 *               image:
 *                 type: string
 *                 description: Optional new group image URL (string URL)
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [groupId]
 *             properties:
 *               groupId:
 *                 type: string
 *                 description: Target group ID (required)
 *               name:
 *                 type: string
 *                 description: Optional new group name
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: Optional new group image file (jpg/png)
 *     responses:
 *       200:
 *         description: "Group profile updated (all group members notified via socket)"
 *       404:
 *         description: API logic issue - token missing or invalid / Group not found
 */
router.put(
  "/group/profile",
  auth,
  subscriptionRequired,
  uploadMedia(["image"], 0, {}).single("image"),
  updateGroupProfileByCreator,
  uploadLimitErrorHandler
);

export default router;
