import express from "express";
import auth from "../middlewares/auth.js";
import { adminOnly, ownerOrAdmin } from "../middlewares/role.js";
import { uploadMedia } from "../middlewares/uploadMedia.js";
import {
  createPost,
  getAllPosts,
  getPostById,
  updatePost,
  deletePost,
  bulkDeletePosts,
} from "../controller/postController.js";

const router = express.Router();

const conditionalPostMediaUpload = (req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    return uploadMedia(["image", "video"]).single("media")(req, res, next);
  }
  return next();
};

/**
 * @swagger
 * tags:
 *   name: Posts
 */

// Public routes

/**
 * @swagger
 * /api/post:
 *   get:
 *     summary: Get all posts (public)
 *     tags: [Posts]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Number of posts per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by content
 *       - in: query
 *         name: orderBy
 *         schema:
 *           type: string
 *           enum: [createdAt, updatedAt]
 *           default: createdAt
 *         description: Field to sort by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Posts retrieved successfully
 */
router.get("/", getAllPosts);

/**
 * @swagger
 * /api/post/{id}:
 *   get:
 *     summary: Get post by ID (public)
 *     tags: [Posts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *         example: 6900581abc67d4e7b7fe91cf
 *     responses:
 *       200:
 *         description: Post retrieved successfully (status 1) or Post not found (status 0)
 *       404:
 *         description: API logic issue
 */
router.get("/:id", getPostById);

// Authenticated routes (users or admins)

/**
 * @swagger
 * /api/post:
 *   post:
 *     summary: Create a new post
 *     description: Create a new post by providing description, media type, and media URL (JSON-based, not file upload).
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - description
 *               - mediaType
 *             properties:
 *               description:
 *                 type: string
 *                 description: Post description
 *                 example: Beautiful sunset captured at the beach
 *               mediaType:
 *                 type: string
 *                 enum: [image, video]
 *                 description: Type of media linked with the post
 *                 example: image
 *               mediaUrl:
 *                 type: string
 *                 description: Public or uploaded URL of the media file
 *                 example: /uploads/1762339868510-62337714.jpg
 *     responses:
 *       200:
 *         description: Post created successfully
 *       400:
 *         description: Validation error or missing required fields
 */
router.post("/", auth, createPost);


/**
 * @swagger
 * /api/post/{id}:
 *   put:
 *     summary: Update a post
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *         example: 6900581abc67d4e7b7fe91cf
 *     requestBody:
 *      
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               description:
 *                 type: string
 *                 description: Post description
 *                 example: Updated post description
 *               mediaType:
 *                 type: string
 *                 enum: [image, video]
 *                 description: Type of media to upload
 *                 example: image
 *               media:
 *                 type: string
 *                 format: binary
 *                 description: New media file (image or video)
 *     responses:
 *       200:
 *         description: Post updated successfully
 *       404:
 *         description: API logic issue - token missing or invalid / Post not found
 */
router.put("/:id", auth, ownerOrAdmin, conditionalPostMediaUpload, updatePost);

/**
 * @swagger
 * /api/post/bulk-delete:
 *   delete:
 *     summary: Bulk delete multiple posts by IDs (Admin only)
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - postIds
 *             properties:
 *               postIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["6733acfc0b2bda2dfd2b5f1b", "6733ad0b0b2bda2dfd2b5f1c"]
 *     responses:
 *       200:
 *         description: Bulk delete operation completed successfully
 *       404:
 *         description: Some or all post IDs not found
 *       500:
 *         description: Internal server error
 */
router.delete("/bulk-delete", auth, adminOnly, bulkDeletePosts);

/**
 * @swagger
 * /api/post/{id}:
 *   delete:
 *     summary: Delete a post
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *         example: 6900581abc67d4e7b7fe91cf
 *     responses:
 *       200:
 *         description: Post deleted successfully
 *       404:
 *         description: API logic issue - token missing or invalid / Post not found
 */
router.delete("/:id", auth, ownerOrAdmin, deletePost);




export default router;
