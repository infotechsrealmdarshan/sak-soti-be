import express from "express";
import auth from "../middlewares/auth.js";
import { adminOnly } from "../middlewares/role.js";
import { uploadMedia } from "../middlewares/uploadMedia.js";
import {
  createNews,
  getAllNews,
  getNewsById,
  updateNews,
  deleteNews,
  bulkDeleteNews,
} from "../controller/newsController.js";

const router = express.Router();

const conditionalNewsMediaUpload = (req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    return uploadMedia(["image"]).single("media")(req, res, next);
  }
  return next();
};

/**
 * @swagger
 * tags:
 *   name: News
 */

/**
 * @swagger
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *
 *   schemas:
 *     News:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the news
 *         title:
 *           type: string
 *           description: Title of the news
 *         description:
 *           type: string
 *           description: Description or content of the news
 *         mediaUrl:
 *           type: string
 *           description: Image or media URL for the news
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Creation date of the news
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           description: Last update date of the news
 */

/**
 * @swagger
 * /api/news:
 *   get:
 *     summary: Get all news (with filters, pagination, and sorting)
 *     tags: [News]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of news items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by title, content, or author name
 *       - in: query
 *         name: orderBy
 *         schema:
 *           type: string
 *           enum: [createdAt, updatedAt, title]
 *           default: createdAt
 *         description: Field to sort by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order (ascending or descending)
 *     responses:
 *       200:
 *         description: News retrieved successfully
 *       500:
 *         description: Internal server error
 */
router.get("/", getAllNews);


/**
 * @swagger
 * /api/news/{id}:
 *   get:
 *     summary: Get a single news item by ID
 *     tags: [News]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: News ID
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A single news item
 *       404:
 *         description: News not found
 *       500:
 *         description: Internal server error
 */
router.get("/:id", getNewsById);

/**
 * @swagger
 * /api/news:
 *   post:
 *     summary: Create a new news item (Admin only)
 *     description: Create a news item by providing title, description, and media URL (JSON-based, not file upload).
 *     tags: [News]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - description
 *               - mediaUrl
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Breaking News: React 19 Released"
 *               description:
 *                 type: string
 *                 example: "React 19 introduces improved server components and more..."
 *               mediaUrl:
 *                 type: string
 *                 example: "/uploads/1762339868510-62337714.jpg"
 *     responses:
 *       200:
 *         description: News created successfully
 *       400:
 *         description: Validation error or missing required fields
 *       404:
 *         description: API logic issue - token missing or invalid
 */
router.post("/", auth, adminOnly, createNews);


/**
 * @swagger
 * /api/news/{id}:
 *   put:
 *     summary: Update existing news by ID (Admin only)
 *     tags: [News]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: News ID
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Updated News Title"
 *               description:
 *                 type: string
 *                 example: "Updated description of the news"
 *               media:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: News updated successfully
 *       404:
 *         description: API logic issue - token missing or invalid / News not found
 */
router.put("/:id", auth, adminOnly, conditionalNewsMediaUpload, updateNews);

/**
 * @swagger
 * /api/news/bulk-delete:
 *   delete:
 *     summary: Bulk delete multiple news items by IDs (Admin only)
 *     tags: [News]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ids
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["6733acfc0b2bda2dfd2b5f1b", "6733ad0b0b2bda2dfd2b5f1c"]
 *     responses:
 *       200:
 *         description: Bulk delete operation completed
 *       404:
 *         description: Some or all News IDs not found
 *       500:
 *         description: Internal server error
 */
router.delete("/bulk-delete", auth, adminOnly, bulkDeleteNews);


/**
 * @swagger
 * /api/news/{id}:
 *   delete:
 *     summary: Delete a news item by ID (Admin only)
 *     tags: [News]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: News ID
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: News deleted successfully
 *       404:
 *         description: API logic issue - token missing or invalid / News not found
 */
router.delete("/:id", auth, adminOnly, deleteNews);



export default router;
