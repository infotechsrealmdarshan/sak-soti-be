// routes/stripeRoutes.js
import express from "express";
import auth from "../middlewares/auth.js";
import {
  getPlans,
  createSubscription,
  stripeWebhook,
  getUserSubscriptions,
  getAllSubscriptionsAdmin,
  cancelSubscription,
  getSubscriptionById,
} from "../controller/stripeController.js";
import { adminOnly } from "../middlewares/role.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Subscription
 *   description: Stripe subscription management APIs
 */

/**
 * @swagger
 * /api/subscription/plans:
 *   get:
 *     tags: [Subscription]
 *     summary: Get available plans
 *     responses:
 *       200:
 *         description: Plans fetched successfully
 */
router.get("/plans", getPlans);

/**
 * @swagger
 * /api/subscription/create:
 *   post:
 *     tags: [Subscription]
 *     summary: Create a new subscription
 *     description: Creates a subscription for the logged-in user.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               planType:
 *                 type: string
 *                 enum: [monthly, yearly]
 *               paymentMethodId:
 *                 type: string
 *                 example: pm_1SSxkvDzEd1MwuqijKGVnBH2
 *     responses:
 *       200:
 *         description: Subscription created successfully
 */
router.post("/create", auth, createSubscription);

/**
 * @swagger
 * /api/subscription/webhook:
 *   post:
 *     tags: [Subscription]
 *     summary: Stripe Webhook
 *     description: Handles Stripe events (public endpoint).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             example:
 *               id: evt_1AbCdEfGhIjKlMnOp 
* responses:
 *       200:
 *         description: Webhook received successfully
 *       400:
 *         description: Invalid signature or malformed event
 */
router.post(
  "/webhook",
  express.raw({ type: "application/json" }), // must be raw for stripe signature verification
  stripeWebhook
);

/**
 * @swagger
 * /api/subscription/list:
 *   get:
 *     tags: [Subscription]
 *     summary: Get current or all user subscriptions
 *     description: Fetch either the current active subscription or all past subscriptions directly from Stripe for the logged-in user.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [current, all]
 *         required: true
 *         description: Use `current` for only active subscription, or `all` for full history.
 *     responses:
 *       200:
 *         description: Subscriptions fetched successfully
 */
router.get("/list", auth, getUserSubscriptions);

/**
 * @swagger
 * /api/subscription/admin/list:
 *   get:
 *     tags: [Subscription]
 *     summary: Get all subscriptions (admin)
 *     description: Returns detailed subscription records enriched with Stripe invoice and payment method data.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscriptions fetched successfully
 *       403:
 *         description: Admin access required
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number (1-based)
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
 *         description: Search by subscription id, customer id, status, plan type, or user name/email
 *       - in: query
 *         name: orderBy
 *         schema:
 *           type: string
 *           enum: [createdAt, updatedAt, status, planType, amount, startDate, endDate, customer, subscription, user]
 *           default: createdAt
 *         description: Field to sort by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort direction
 */
router.get("/admin/list", auth, adminOnly, getAllSubscriptionsAdmin);

/**
 * @swagger
 * /api/subscription/admin/{subscriptionId}:
 *   get:
 *     tags: [Subscription]
 *     summary: Get any subscription by ID (Admin only)
 *     description: Fetch detailed information about any subscription by ID. Admin access required.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subscriptionId
 *         schema:
 *           type: string
 *         required: true
 *         description: The Stripe subscription ID
 *     responses:
 *       200:
 *         description: Subscription details fetched successfully
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Subscription not found
 *       500:
 *         description: Internal server error
 */
router.get("/admin/:subscriptionId", auth, adminOnly, getSubscriptionById);

/**
 * @swagger
 * /api/subscription/cancel:
 *   delete:
 *     tags: [Subscription]
 *     summary: Cancel active subscription (disable auto-pay / auto-renew)
 *     description: |
 *       Cancels the user's active Stripe subscription by scheduling it to end at the current billing period. 
 *       This disables auto-renewal (auto-pay). The actual subscription and user data in the database will be updated later by the Stripe webhook.
 *     security:
 *       - bearerAuth: []   # Requires JWT auth
 *     responses:
 *       200:
 *         description: Subscription cancellation requested successfully
 *       404:
 *         description: No active subscription found
 *       500:
 *         description: Error canceling subscription
 */
router.delete("/cancel", auth, cancelSubscription);


export default router;
