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
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscriptions fetched successfully
 *       403:
 *         description: Admin access required
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

export default router;
