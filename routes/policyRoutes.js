import express from "express";
import auth from "../middlewares/auth.js";
import {
  createPolicy,
  updatePolicy,
  getLatestPolicy,
  getPolicyById,
  deletePolicy,
} from "../controller/policyController.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   - name: Policy
 *     description: Manage Privacy Policy content
 */

/**
 * @swagger
 * /api/policy:
 *   post:
 *     summary: Create Privacy Policy (Admin only)
 *     tags: [Policy]
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
 *                 example: "<p>Privacy Policy content here.</p>"
 *     responses:
 *       200:
 *         description: Privacy Policy created successfully
 *       403:
 *         description: Admin access required
 */
router.post("/", auth, createPolicy);

/**
 * @swagger
 * /api/policy/{id}:
 *   put:
 *     summary: Update Privacy Policy by ID (Admin only)
 *     tags: [Policy]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           example: 6740b9f2b0a7f7eeb9b9c111
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               contentHtml:
 *                 type: string
 *                 example: "<p>Updated privacy policy text.</p>"
 *     responses:
 *       200:
 *         description: Privacy Policy updated successfully
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Policy not found
 */
router.put("/:id", auth, updatePolicy);

/**
 * @swagger
 * /api/policy:
 *   get:
 *     summary: Get latest Privacy Policy
 *     tags: [Policy]
 *     responses:
 *       200:
 *         description: Latest Privacy Policy fetched successfully
 *       404:
 *         description: Not found
 */
router.get("/", getLatestPolicy);

/**
 * @swagger
 * /api/policy/{id}:
 *   get:
 *     summary: Get Privacy Policy by ID
 *     tags: [Policy]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Policy fetched successfully
 *       404:
 *         description: Policy not found
 */
router.get("/:id", getPolicyById);

/**
 * @swagger
 * /api/policy/{id}:
 *   delete:
 *     summary: Delete Privacy Policy (Admin only)
 *     tags: [Policy]
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
 *         description: Policy deleted successfully
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Policy not found
 */
router.delete("/:id", auth, deletePolicy);

export default router;
