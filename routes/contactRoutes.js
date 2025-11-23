import express from "express";
import {
  createContact,
  getAllContacts,
  getContactById,
  getMyContacts,
} from "../controller/contactController.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Contact
 *   description: Contact form management APIs
 */

/**
 * @swagger
 * /api/contact:
 *   post:
 *     tags: [Contact]
 *     summary: Submit a contact form (User only)
 *     description: Logged-in users can send a message with full name, email, phone, and message.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fullName
 *               - email
 *               - phoneNumber
 *               - message
 *             properties:
 *               fullName:
 *                 type: string
 *                 example: Darshan Bamaroliya
 *               email:
 *                 type: string
 *                 example: darshan@example.com
 *               phoneNumber:
 *                 type: string
 *                 example: "+919876543210"
 *               message:
 *                 type: string
 *                 example: "I am interested in your services."
 *     responses:
 *       200:
 *         description: Contact form submitted successfully
 *       400:
 *         description: Missing or invalid input
 */
router.post("/", auth, createContact);

/**
 * @swagger
 * /api/contact/me:
 *   get:
 *     tags: [Contact]
 *     summary: Get user's own contact requests (User only)
 *     description: Retrieve all contact messages submitted by the currently logged-in user.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of user's contact messages
 */
router.get("/me", auth, getMyContacts);

/**
 * @swagger
 * /api/contact/all:
 *   get:
 *     tags: [Contact]
 *     summary: Get all contact messages (Admin only)
 *     description: Retrieve all contact submissions with search, pagination, sort, and filter options. Accessible only by admin users.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           example: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           example: 10
 *         description: Number of contacts per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *           example: darshan
 *         description: Search in fullName or email (case-insensitive)
 *       - in: query
 *         name: orderBy
 *         schema:
 *           type: string
 *           enum: [fullName, email, createdAt]
 *           example: createdAt
 *         description: Field to order by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           example: desc
 *         description: Sort order (ascending or descending)
 *     responses:
 *       200:
 *         description: Successfully retrieved contact list
 *       403:
 *         description: Forbidden — Only admins can access this route
 */
router.get("/all", auth, getAllContacts);


/**
 * @swagger
 * /api/contact/{id}:
 *   get:
 *     tags: [Contact]
 *     summary: Get contact details by ID (Admin only)
 *     description: Retrieve detailed information for a specific contact submission by ID. Accessible only by admin users.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: Contact ID
 *         schema:
 *           type: string
 *           example: 6733e8f4b87f9c9c19b4a9b3
 *     responses:
 *       200:
 *         description: Contact details retrieved successfully
 *       404:
 *         description: Contact not found
 *       403:
 *         description: Forbidden — Only admins can access this route
 */
router.get("/:id", auth, getContactById);

export default router;
