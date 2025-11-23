// routes/stripeRoutes.js
import express from "express";
import auth from "../middlewares/auth.js";
import {
  getPlans,
  stripeWebhook,
  getUserSubscriptions,
  getAllSubscriptionsAdmin,
  cancelSubscription,
  getSubscriptionById,
  selectPlan,
  verifyCheckoutSession,
  getUserTransactionsAdmin,
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
 * /api/subscription/select-plan:
 *   post:
 *     tags: [Subscription]
 *     summary: Step 1 - Select subscription plan
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - planType
 *             properties:
 *               planType:
 *                 type: string
 *                 enum: [monthly, yearly, testing]
 *                 description: Type of subscription plan
 *                 example: monthly
 *               priceId:
 *                 type: string
 *                 description: Direct Stripe price ID (alternative to planType)
 *                 example: price_1XYZabc123def
 *     responses:
 *       200:
 *         description: Plan selected successfully. SetupIntent created for payment method collection.
 *       400:
 *         description: Bad request - missing planType or user already has subscription
 *       404:
 *         description: User not found or plan not found
 *       500:
 *         description: Internal server error
 */
router.post("/select-plan", auth, selectPlan);

/**
 * @swagger
 * /api/subscription/success-payment:
 *   post:
 *     tags: [Subscription]
 *     summary: Verify payment intent and activate subscription (Flutter only)
 *     description: For Flutter direct payments using Payment Intent
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - paymentIntentId
 *             properties:
 *               paymentIntentId:
 *                 type: string
 *                 description: Payment Intent ID from Flutter Stripe SDK
 *                 example: pi_3MtwBwLkdIwHu7ix28a3tqPa
 *     responses:
 *       200:
 *         description: Subscription activated successfully
 *       400:
 *         description: Bad request - missing paymentIntentId or payment not completed
 *       404:
 *         description: Payment intent not found or no subscription
 *       500:
 *         description: Internal server error
 */
router.post("/success-payment", auth, verifyCheckoutSession);

/**
 * @swagger
 * /api/subscription/webhook:
 *   post:
 *     tags: [Subscription]
 *     summary: Stripe Webhook
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
 *     description: Get paginated list of all subscriptions with search and sorting
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: perPage
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search across subscription ID, customer ID, plan type, status, user name, or email
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order by creation date
 *     responses:
 *       200:
 *         description: Subscriptions fetched successfully
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Internal server error
 */
router.get("/admin/list", auth, adminOnly, getAllSubscriptionsAdmin);

/**
 * @swagger
 * /api/subscription/admin/{subscriptionId}:
 *   get:
 *     tags: [Subscription]
 *     summary: Get any subscription by ID (Admin only)
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

/**
 * @swagger
 * /api/subscription/admin/user/{userId}/transactions:
 *   get:
 *     tags: [Subscription]
 *     summary: Get all transactions for a specific user (Admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to fetch transactions for
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
 *           default: 20
 *         description: Number of transactions per page
 *     responses:
 *       200:
 *         description: User transactions fetched successfully
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 */
router.get("/admin/user/:userId/transactions", auth, adminOnly, getUserTransactionsAdmin);

export default router;