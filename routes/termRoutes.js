import express from "express";
import auth from "../middlewares/auth.js";
import {
  createOrUpdateTerms,
  updateTermsById,
  deleteTermsById,
  getLatestTerms,
  getTermsById,
} from "../controller/termController.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Terms
 *   description: Terms & Conditions management
 */

/**
 * @swagger
 * /api/terms:
 *   post:
 *     summary: Create or update Terms & Conditions (Admin only)
 *     description: Only admin users can create or update the Terms & Conditions.
 *     tags: [Terms]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               contentHtml:
 *                 type: string
 *                 example: "<h1>Terms & Conditions</h1><p>Updated terms...</p>"
 *     responses:
 *       200:
 *         description: Terms & Conditions saved successfully
 *       403:
 *         description: Access denied (admin only)
 */
router.post("/", auth, createOrUpdateTerms);

/**
 * @swagger
 * /api/terms/{id}:
 *   put:
 *     summary: Update Terms & Conditions by ID (Admin only)
 *     description: Only admin users can update specific Terms & Conditions by ID.
 *     tags: [Terms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Terms ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               contentHtml:
 *                 type: string
 *                 example: "<h2>Updated Terms & Conditions Content</h2>"
 *     responses:
 *       200:
 *         description: Terms & Conditions updated successfully
 *       403:
 *         description: Access denied
 *       404:
 *         description: Not found
 */
router.put("/:id", auth, updateTermsById);

/**
 * @swagger
 * /api/terms/{id}:
 *   delete:
 *     summary: Delete Terms & Conditions by ID (Admin only)
 *     description: Permanently remove a specific Terms & Conditions entry by ID.
 *     tags: [Terms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Terms ID
 *     responses:
 *       200:
 *         description: Terms & Conditions deleted successfully
 *       403:
 *         description: Access denied
 *       404:
 *         description: Not found
 */
router.delete("/:id", auth, deleteTermsById);

/**
 * @swagger
 * /api/terms:
 *   get:
 *     summary: Get the latest Terms & Conditions
 *     description: Fetch the most recently updated Terms & Conditions.
 *     tags: [Terms]
 *     responses:
 *       200:
 *         description: Terms & Conditions fetched successfully
 *       404:
 *         description: Not found
 */
router.get("/", getLatestTerms);

/**
 * @swagger
 * /api/terms/{id}:
 *   get:
 *     summary: Get Terms & Conditions by ID
 *     description: Fetch specific Terms & Conditions document by its ID.
 *     tags: [Terms]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Terms ID
 *     responses:
 *       200:
 *         description: Terms & Conditions fetched successfully
 *       404:
 *         description: Not found
 */
router.get("/:id", getTermsById);

export default router;
