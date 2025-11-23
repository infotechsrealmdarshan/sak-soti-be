import express from "express";
import { uploadFile, uploadMedia, uploadLimitErrorHandler } from "../controller/uploadController.js";

const router = express.Router();

/**
 * @swagger
 * /api/upload:
 *   post:
 *     summary: Upload a file (common upload API)
 *     description: Common file upload endpoint that can be used for posts, profiles, or any file upload needs. Supports images, videos, audio, and PDFs.
 *     tags: [Upload]
 *     consumes:
 *       - multipart/form-data
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
 *                 description: File to upload (image, video, audio, or PDF)
 *     responses:
 *       200:
 *         description: File uploaded successfully (status 1) or No file uploaded (status 0)
 */
router.post("/", uploadMedia(["image", "video", "audio", "pdf"]).single("file"), uploadLimitErrorHandler, uploadFile);

export default router;