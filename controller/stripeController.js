// controller/stripeController.js
import Stripe from "stripe";
import User from "../models/User.js";
import Subscription from "../models/Subscription.js";
import { successResponse, errorResponse } from "../utils/response.js";
import { createStripeCustomer } from "../utils/stripeHelper.js";
import fs from "fs";
import path from "path";
import { asyncHandler } from "../utils/errorHandler.js";
import { notifyUser } from "../utils/notificationHelper.js";
import { formatSubscriptionResponse } from "../utils/subscriptionResponseFormatter.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// File logging for webhook
const logPath = path.join(process.cwd(), "subscription_log.txt");
const logSubscriptionLifecycle = async (eventType, stripeData, user = null, additionalInfo = {}) => {
  try {
    // ✅ IMPROVED: Extract ID from different data structures
    let dataId = 'Unknown ID';

    if (stripeData) {
      if (stripeData.id) {
        dataId = stripeData.id;
      } else if (stripeData.sessionId) {
        dataId = stripeData.sessionId;
      } else if (stripeData.priceId) {
        dataId = stripeData.priceId;
      } else if (stripeData.subscriptionId) {
        dataId = stripeData.subscriptionId;
      } else if (stripeData.paymentIntentId) {
        dataId = stripeData.paymentIntentId;
      }
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      eventType,
      user: user ? {
        id: user._id?.toString(),
        email: user.email,
        stripeCustomerId: user.stripeCustomerId
      } : null,
      stripeData: stripeData,
      additionalInfo,
      environment: process.env.NODE_ENV || 'development'
    };

    // ✅ SINGLE LINE JSON (no formatting)
    const singleLineJson = JSON.stringify(logEntry);

    // ✅ APPEND TO FILE WITH NEW LINE
    fs.appendFileSync(logPath, singleLineJson + '\n', { encoding: "utf8" });

    console.log(`📝 Subscription Lifecycle Logged: ${eventType} - ${dataId}`);
  } catch (e) {
    console.error("❌ Could not write lifecycle log:", e.message);
  }
};

export const describePlan = (price, product = null) => {
  const interval = price?.recurring?.interval || null;
  const nickname = price?.nickname || null;

  // Get product name if available
  const productName = product?.name || price?.product?.name || null;

  // Determine plan type based on product name and interval
  let planType = "unknown";
  let planLabel = "Subscription Plan";

  if (productName) {
    const lowerName = productName.toLowerCase();
    if (lowerName.includes("monthly")) {
      planType = "monthly";
      planLabel = "Monthly Plan";
    } else if (lowerName.includes("yearly")) {
      planType = "yearly";
      planLabel = "Yearly Plan";
    } else if (lowerName.includes("testing")) {
      planType = "testing";
      planLabel = "Testing Plan";
    } else {
      // Fallback to interval-based detection
      planType = interval === "year" ? "yearly" : interval === "month" ? "monthly" : "testing";
      planLabel = productName;
    }
  } else {
    // Fallback to interval-based detection
    planType = interval === "year" ? "yearly" : interval === "month" ? "monthly" : "testing";
    planLabel = interval === "year" ? "Yearly Plan" : interval === "month" ? "Monthly Plan" : "Testing Plan";
  }

  return { interval, nickname, planLabel, planType, productName };
};

const toISODateTime = (seconds) => {
  if (!seconds) return "";
  return new Date(seconds * 1000).toISOString();
};

const toISODate = (seconds) => {
  const iso = toISODateTime(seconds);
  return iso ? iso.slice(0, 10) : "";
};

export const selectPlan = async (req, res) => {
  try {
    const userId = req.user.id.toString();
    const { planType, priceId: customPriceId } = req.body;

    const user = await User.findById(userId);
    if (!user) return errorResponse(res, "User not found", 404);

    if (!planType && !customPriceId) {
      return errorResponse(res, "planType or priceId is required", 400);
    }

    if (user.isSubscription) {
      return errorResponse(res, "You already have an active subscription", 400);
    }

    // Ensure stripe customer exists
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      stripeCustomerId = await createStripeCustomer(user);
      user.stripeCustomerId = stripeCustomerId;
      await user.save();
    }

    // Determine price ID
    let priceId = customPriceId;
    if (!priceId && planType) {
      const products = await stripe.products.list({ active: true, limit: 10 });
      let targetProduct = null;

      for (const product of products.data) {
        const lowerName = product.name.toLowerCase();
        if (
          (planType === "monthly" && lowerName.includes("monthly")) ||
          (planType === "yearly" && lowerName.includes("yearly")) ||
          (planType === "testing" && lowerName.includes("testing"))
        ) {
          targetProduct = product;
          break;
        }
      }

      if (!targetProduct) {
        return errorResponse(res, `No product found for plan type: ${planType}`, 404);
      }

      const prices = await stripe.prices.list({
        product: targetProduct.id,
        active: true,
        limit: 1,
      });

      if (!prices.data.length) {
        return errorResponse(res, `No active price found for ${targetProduct.name}`, 404);
      }

      priceId = prices.data[0].id;
    }

    if (!priceId) {
      return errorResponse(res, "Could not determine price ID", 400);
    }

    // Validate price
    let priceDetails;
    try {
      priceDetails = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    } catch (error) {
      return errorResponse(res, "Invalid price ID", 400);
    }

    const { planType: detectedPlanType } = describePlan(priceDetails, priceDetails.product);

    // ✅ METHOD 1: Create Payment Intent First (More Reliable)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: priceDetails.unit_amount,
      currency: priceDetails.currency,
      customer: stripeCustomerId,
      setup_future_usage: 'off_session', // For subscriptions
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never'
      },
      payment_method_types: ['card'],
      metadata: {
        userId: user._id.toString(),
        planType: detectedPlanType,
        priceId: priceId
      }
    });

    // ✅ Calculate temporary dates (will be updated when Stripe subscription is created)
    const now = new Date();
    const tempEndDate = new Date(now);
    // Set a temporary end date based on plan type
    if (detectedPlanType === "yearly") {
      tempEndDate.setFullYear(tempEndDate.getFullYear() + 1);
    } else if (detectedPlanType === "monthly") {
      tempEndDate.setMonth(tempEndDate.getMonth() + 1);
    } else {
      tempEndDate.setDate(tempEndDate.getDate() + 1);
    }

    let subscriptionRecord = await Subscription.findOne({
      userId: user._id,
      status: { $in: ["pending_payment", "in_progress"] } // ✅ Only check pending subscriptions
    }).sort({ createdAt: -1 });

    if (subscriptionRecord) {
      // Update existing pending subscription
      subscriptionRecord.stripeCustomerId = stripeCustomerId;
      subscriptionRecord.priceId = priceId;
      subscriptionRecord.amount = priceDetails.unit_amount / 100;
      subscriptionRecord.currency = priceDetails.currency;
      subscriptionRecord.planType = detectedPlanType;
      subscriptionRecord.status = "pending_payment";
      subscriptionRecord.stripePaymentIntentId = paymentIntent.id;
      subscriptionRecord.startDate = now;
      subscriptionRecord.endDate = tempEndDate;
      await subscriptionRecord.save();
    } else {
      // ✅ Create new subscription - stripeSubscriptionId field ADD NA KARO
      subscriptionRecord = await Subscription.create({
        userId: user._id,
        stripeCustomerId,
        priceId,
        amount: priceDetails.unit_amount / 100,
        currency: priceDetails.currency,
        planType: detectedPlanType,
        status: "pending_payment",
        stripePaymentIntentId: paymentIntent.id,
        startDate: now,
        endDate: tempEndDate
        // ✅ stripeSubscriptionId field intentionally skip karo
      });
    }

    // ✅ Create Ephemeral Key for Flutter PaymentSheet
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: stripeCustomerId },
      { apiVersion: '2023-10-16' }
    );

    await logSubscriptionLifecycle("PLAN_SELECTED_PAYMENT_INTENT", {
      priceId,
      planType: detectedPlanType,
      paymentIntentId: paymentIntent.id
    }, user);

    // ✅ Return EXACT fields you need
    return successResponse(res, "Complete payment to activate your subscription", {
      // ✅ For Flutter Stripe SDK
      paymentIntentClientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,

      // ✅ For Flutter PaymentSheet
      customerId: stripeCustomerId,
      customerEphemeralKeySecret: ephemeralKey.secret,

      // ✅ Subscription details
      subscription: {
        id: subscriptionRecord._id,
        status: "pending_payment",
        planType: detectedPlanType,
        amount: priceDetails.unit_amount / 100,
        currency: priceDetails.currency,
      },

      requiresPayment: true,
    });
  } catch (error) {
    console.error("❌ selectPlan error:", error);

    if (error.code === 11000) {
      const duplicateField = error.keyPattern ? Object.keys(error.keyPattern)[0] : 'unknown';
      console.error(`❌ Duplicate key error on field: ${duplicateField}`, error.keyValue);

      // Get user ID from request
      const userId = req.user?.id || req.user?._id;

      // Try to find and return existing subscription
      try {
        if (userId) {
          const existingSub = await Subscription.findOne({
            userId: userId
          }).sort({ createdAt: -1 });

          if (existingSub) {
            const userForLog = await User.findById(userId);
            console.log(`✅ Found existing subscription for user: ${userForLog?.email || userId}`);

            // If it's a pending subscription, return payment intent info
            if (existingSub.status === "pending_payment" || existingSub.status === "in_progress") {
              let paymentIntentClientSecret = null;
              let paymentIntentId = existingSub.stripePaymentIntentId;

              if (paymentIntentId) {
                try {
                  const existingPaymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
                  paymentIntentClientSecret = existingPaymentIntent.client_secret;
                } catch (piError) {
                  console.warn("⚠️ Could not retrieve existing payment intent:", piError.message);
                }
              }

              return successResponse(res, "Subscription already in progress", {
                paymentIntentClientSecret: paymentIntentClientSecret,
                paymentIntentId: paymentIntentId,
                subscription: {
                  id: existingSub._id,
                  status: existingSub.status,
                  planType: existingSub.planType,
                },
                message: "Please complete the existing payment or wait for it to process"
              });
            } else {
              return successResponse(res, "You already have a subscription", {
                subscription: {
                  id: existingSub._id,
                  status: existingSub.status,
                  planType: existingSub.planType,
                }
              });
            }
          }
        }
      } catch (findError) {
        console.error("❌ Error finding existing subscription:", findError);
      }

      return errorResponse(res, "A subscription record already exists. Please try again or contact support.", 409);
    }

    // Get user for logging
    let userForLog = null;
    try {
      const userId = req.user?.id || req.user?._id;
      if (userId) {
        userForLog = await User.findById(userId);
      }
    } catch (logError) {
      console.warn("⚠️ Could not fetch user for logging:", logError.message);
    }

    await logSubscriptionLifecycle(
      "PLAN_SELECTION_FAILED",
      { error: error.message, code: error.code },
      userForLog,
      {
        apiSource: "selectPlan",
        stack: error.stack,
      }
    );
    return errorResponse(res, "Error selecting plan: " + error.message, 500);
  }
};

/**
 * @desc Get available plan details - Direct Stripe API response
 * @route GET /api/subscription/plans
 * @access Public
 */
export const getPlans = async (req, res) => {
  try {
    // ✅ Direct Stripe API call - no modifications
    const products = await stripe.products.list({
      active: true,
      limit: 100,
      expand: ['data.default_price']
    });

    // ✅ Return exact Stripe API response
    return successResponse(res, "Plans fetched successfully", products);
  } catch (error) {
    console.error("❌ getPlans error:", error);
    return errorResponse(res, "Error fetching plans: " + error.message, 500);
  }
};

const getNextRenewalNumber = async (userId, subscriptionId) => {
  try {
    const previousRenewals = await Subscription.countDocuments({
      userId: userId,
      originalSubscriptionId: subscriptionId,
      isRenewalEntry: true
    });
    return previousRenewals + 1;
  } catch (error) {
    console.error("Error counting renewals:", error);
    return 1;
  }
};

/**
 * @desc Stripe Webhook with Complete Subscription Management
 * @route POST /api/subscription/webhook
 * @access Public
 */
export const stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  // 🚨 CRITICAL: Use raw body for webhook verification
  let rawBody = req.rawBody;
  if (!rawBody && req.body) {
    rawBody = JSON.stringify(req.body);
  }

  if (!rawBody) {
    console.error("❌ No raw body available for webhook verification");
    return res.status(400).send("Webhook Error: No raw body available");
  }

  // ✅ Verify signature
  try {
    if (process.env.NODE_ENV !== "production") {
      event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
      console.log("⚠️ Webhook signature verification skipped (development mode)");
    } else {
      // Production ma ja verification karo
      if (!webhookSecret) {
        console.error("❌ Missing webhook secret");
        return res.status(500).send("Missing webhook secret");
      }
      if (!sig) {
        console.error("❌ No stripe-signature header provided");
        return res.status(400).send("Webhook Error: No stripe-signature header provided");
      }

      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
      console.log("✅ Webhook signature verified successfully");
    }
  } catch (err) {
    console.error("❌ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Handle Stripe Events with Complete Subscription Management
  try {
    console.log(`🔔 Processing event: ${event.type}`);

    const eventData = event.data.object;
    let user = null;

    // Find user for customer events
    if (eventData.customer) {
      user = await User.findOne({ stripeCustomerId: eventData.customer });
    }

    switch (event.type) {
      case "customer.subscription.created": {
        try {
          const sub = eventData;
          console.log(`🎉 New subscription created: ${sub.id}`);

          await logSubscriptionLifecycle(
            'SUBSCRIPTION_CREATED',
            sub,
            user,
            {
              webhookEvent: event.type,
              status: sub.status
            }
          );

          if (user) {
            const price = sub.items?.data?.[0]?.price;
            const { planType } = describePlan(price);

            // ✅ PREVENT DUPLICATE RECORDS
            const existingRecord = await Subscription.findOne({
              stripeSubscriptionId: sub.id
            });

            if (existingRecord) {
              console.log(`ℹ️ Subscription ${sub.id} already exists, skipping creation`);
              break;
            }

            // ✅ CHECK IF THIS IS RENEWAL OR NEW SUBSCRIPTION
            const existingActiveSub = await Subscription.findOne({
              userId: user._id,
              status: "active"
            });

            const isRenewal = !!existingActiveSub;

            // ✅ CREATE SUBSCRIPTION RECORD (ONLY HERE)
            await Subscription.create({
              userId: user._id,
              stripeCustomerId: sub.customer,
              stripeSubscriptionId: sub.id,
              priceId: price?.id,
              amount: price?.unit_amount ? price.unit_amount / 100 : undefined,
              currency: price?.currency,
              planType,
              status: sub.status, // This might be "active", "trialing", etc.
              startDate: new Date(sub.current_period_start * 1000),
              endDate: new Date(sub.current_period_end * 1000),
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              isRenewalEntry: isRenewal,
              originalSubscriptionId: isRenewal ? existingActiveSub.stripeSubscriptionId : null
            });

            console.log(`✅ ${isRenewal ? 'Renewal' : 'New'} subscription created for user: ${user.email}`);
          }
        } catch (error) {
          console.error(`❌ Error in ${event.type}:`, error);
          await logSubscriptionLifecycle('WEBHOOK_CASE_ERROR', { error: error.message }, user);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = eventData;
        console.log(`📝 Subscription updated: ${sub.id}, Status: ${sub.status}`);

        await logSubscriptionLifecycle(
          'SUBSCRIPTION_UPDATED',
          sub,
          user,
          {
            webhookEvent: event.type,
            status: sub.status,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            previousAttributes: event.data.previous_attributes || {}
          }
        );

        if (user) {
          const price = sub.items?.data?.[0]?.price;
          const { planType } = describePlan(price);

          // ✅ FIND THE CORRECT SUBSCRIPTION RECORD
          const subscriptionRecord = await Subscription.findOne({
            stripeSubscriptionId: sub.id
          });

          if (subscriptionRecord) {
            const updateData = {
              status: sub.status,
              startDate: new Date(sub.current_period_start * 1000),
              endDate: new Date(sub.current_period_end * 1000),
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              cancelAtPeriodEnd: sub.cancel_at_period_end || false,
            };

            // ✅ HANDLE CANCELLATION/EXPIRY
            if (sub.status === "canceled" || sub.status === "expired") {
              updateData.isSubscriptionCancelled = true;
              updateData.canceledAt = new Date();

              // ✅ SET USER SUBSCRIPTION TO FALSE WHEN ACTUALLY ENDED
              user.isSubscription = false;
              user.isSubscriptionCancelled = true;
              user.subscriptionCanceledAt = new Date();
            } else if (sub.cancel_at_period_end) {
              updateData.status = "cancel_scheduled";
              updateData.canceledAt = new Date();
              // ✅ SERVICE CONTINUES UNTIL PERIOD END
              user.isSubscription = true;
              user.isSubscriptionCancelled = true;
            } else {
              // ✅ ACTIVE SUBSCRIPTION
              user.isSubscription = true;
              user.isSubscriptionCancelled = false;
            }

            // Update subscription type if available
            if (planType !== "unknown") {
              user.subscriptionType = planType;
            }

            user.subscriptionStartDate = new Date(sub.current_period_start * 1000);
            user.subscriptionEndDate = new Date(sub.current_period_end * 1000);

            await subscriptionRecord.updateOne(updateData);
            await user.save();

            console.log(`✅ Subscription updated: ${sub.id}, Status: ${sub.status}`);
          }
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = eventData;
        const subscriptionId = invoice.subscription;

        console.log(`💰 INVOICE PAYMENT SUCCEEDED:`, {
          invoiceId: invoice.id,
          subscriptionId: subscriptionId,
          billingReason: invoice.billing_reason,
          paid: invoice.paid,
          amountPaid: invoice.amount_paid
        });

        if (subscriptionId && invoice.paid === true) {
          try {
            const stripeSub = await stripe.subscriptions.retrieve(subscriptionId, {
              expand: ['items.data.price']
            });

            let targetUser = await User.findOne({ stripeCustomerId: stripeSub.customer });
            if (!targetUser && stripeSub.metadata?.userId) {
              targetUser = await User.findById(stripeSub.metadata.userId);
            }

            if (!targetUser) {
              console.log(`❌ User not found for subscription: ${subscriptionId}`);
              break;
            }

            const price = stripeSub.items?.data?.[0]?.price;
            const { planType } = describePlan(price);

            // ✅ IMPROVED RENEWAL DETECTION
            const isRenewal = invoice.billing_reason === "subscription_cycle" ||
              invoice.billing_reason === "subscription_update" ||
              (invoice.billing_reason === "subscription_create" &&
                await Subscription.exists({ userId: targetUser._id, status: "active" }));

            console.log(`🔄 Payment Type: ${isRenewal ? 'RENEWAL' : 'INITIAL'}`);

            if (isRenewal) {
              // ✅ RENEWAL - CREATE NEW SUBSCRIPTION ENTRY
              console.log(`🔄 Subscription Renewed: ${stripeSub.id}`);

              await Subscription.create({
                userId: targetUser._id,
                stripeCustomerId: stripeSub.customer,
                stripeSubscriptionId: stripeSub.id,
                priceId: price?.id,
                amount: price?.unit_amount ? price.unit_amount / 100 : undefined,
                currency: price?.currency,
                planType: planType,
                status: "active",
                startDate: new Date(stripeSub.current_period_start * 1000),
                endDate: new Date(stripeSub.current_period_end * 1000),
                currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
                currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
                isRenewalEntry: true,
                latestInvoiceId: invoice.id,
              });

              // Update User with new period
              targetUser.subscriptionStartDate = new Date(stripeSub.current_period_start * 1000);
              targetUser.subscriptionEndDate = new Date(stripeSub.current_period_end * 1000);
              targetUser.lastSubscriptionDate = new Date();
              targetUser.isSubscription = true;
              targetUser.subscriptionType = planType;
              await targetUser.save();

              console.log(`✅ Renewal processed for: ${targetUser.email}`);

            } else {
              // ✅ INITIAL PAYMENT - ACTIVATE FIRST SUBSCRIPTION
              console.log(`✅ Initial subscription activated: ${stripeSub.id}`);

              await Subscription.findOneAndUpdate(
                {
                  userId: targetUser._id,
                  stripeSubscriptionId: stripeSub.id
                },
                {
                  status: "active",
                  planType: planType,
                  startDate: new Date(stripeSub.current_period_start * 1000),
                  endDate: new Date(stripeSub.current_period_end * 1000),
                  currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
                  currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
                  latestInvoiceId: invoice.id,
                  activatedAt: new Date(),
                },
                { upsert: true }
              );

              // Update User
              targetUser.isSubscription = true;
              targetUser.subscriptionType = planType;
              targetUser.subscriptionStartDate = new Date(stripeSub.current_period_start * 1000);
              targetUser.subscriptionEndDate = new Date(stripeSub.current_period_end * 1000);
              targetUser.subscriptionActivatedAt = new Date();
              await targetUser.save();

              console.log(`✅ User activated via webhook: ${targetUser.email}`);
            }

            // ✅ SEND NOTIFICATION
            await notifyUser(
              targetUser,
              isRenewal ? "Subscription Renewed 🔄" : "Subscription Activated 🎉",
              isRenewal
                ? `Your ${planType} subscription has been renewed. Next billing: ${toISODate(stripeSub.current_period_end)}`
                : `Your ${planType} subscription is now active. Enjoy premium features until ${toISODate(stripeSub.current_period_end)}.`,
              {
                deeplink: "/subscription",
                data: {
                  action: isRenewal ? "subscription_renewed" : "subscription_activated",
                  subscriptionId: stripeSub.id,
                  planType: planType
                },
              }
            );

            // ✅ LOG SUCCESS
            await logSubscriptionLifecycle(
              isRenewal ? 'SUBSCRIPTION_RENEWED' : 'SUBSCRIPTION_ACTIVATED',
              stripeSub,
              targetUser,
              {
                webhookEvent: event.type,
                billingReason: invoice.billing_reason,
                invoiceId: invoice.id,
                isRenewal: isRenewal
              }
            );

          } catch (error) {
            console.error("❌ ERROR in invoice.payment_succeeded:", error);
            await logSubscriptionLifecycle(
              'WEBHOOK_PROCESSING_ERROR',
              { error: error.message, subscriptionId },
              null,
              {
                webhookEvent: event.type,
                stack: error.stack
              }
            );
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = eventData;
        console.log(`🗑️ Subscription deleted: ${sub.id}`);

        // ✅ SINGLE LOG ENTRY
        await logSubscriptionLifecycle(
          'SUBSCRIPTION_DELETED',
          sub,
          user,
          {
            webhookEvent: event.type,
            status: 'canceled'
          }
        );

        if (user) {
          // ✅ UPDATE SUBSCRIPTION RECORD
          await Subscription.findOneAndUpdate(
            { userId: user._id },
            {
              status: "canceled",
              isSubscriptionCancelled: true, // ✅ KEEP CANCELLATION FLAG
              canceledAt: new Date(),
              endDate: new Date(sub.current_period_end * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            }
          );

          // ✅ NOW SET isSubscription: false BECAUSE SERVICE ACTUALLY ENDED
          user.isSubscription = false; // ✅ SERVICE ENDED
          user.isSubscriptionCancelled = true; // ✅ KEEP CANCELLATION FLAG
          user.subscriptionType = null;
          user.subscriptionCanceledAt = new Date(); // ✅ KEEP CANCELLATION DATE
          user.subscriptionEndDate = new Date(sub.current_period_end * 1000); // ✅ ACTUAL END DATE
          await user.save();

          console.log(`✅ User subscription fully ended: ${user.email}`);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = eventData;
        console.log(`❌ Payment failed for invoice: ${invoice.id}`);

        // ✅ SINGLE LOG ENTRY
        await logSubscriptionLifecycle(
          'PAYMENT_FAILED',
          invoice,
          user,
          {
            webhookEvent: event.type,
            attemptCount: invoice.attempt_count,
            nextPaymentAttempt: invoice.next_payment_attempt
          }
        );

        if (user) {
          // Optionally set user to not subscribed if payment fails
          // user.isSubscription = false;
          // await user.save();

          console.log(`⚠️ Payment failed for user: ${user.email}`);
        }
        break;
      }

      default:
        console.log(`⚡ Unhandled event type: ${event.type}`);
        break;
    }

    return res.json({ received: true, processed: true });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(500).send("Webhook handler error");
  }
};

/**
 * @desc Cancel active subscription - ONLY SET FLAG & DATE, KEEP SERVICE ACTIVE
 * @route DELETE /api/subscription/cancel
 * @access Private (User)
 */
export const cancelSubscription = asyncHandler(async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user?.stripeCustomerId) {
      return errorResponse(res, "Stripe customer not found", 404);
    }

    // Find active Stripe subscription
    const activeSub = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: "active",
      limit: 1,
    });

    if (!activeSub.data.length) {
      return errorResponse(res, "No active subscription found", 404);
    }

    const sub = activeSub.data[0];

    if (sub.cancel_at_period_end) {
      return successResponse(res, "Subscription already scheduled for cancellation", {
        subscriptionId: sub.id,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        status: sub.status,
        isSubscriptionCancelled: true,
        isSubscription: true // ✅ SERVICE STILL ACTIVE
      });
    }

    // Schedule cancel at period end
    const canceled = await stripe.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
    });

    // ✅ ONLY SET CANCELLATION FLAG & DATE, KEEP isSubscription: true
    const currentDate = new Date();

    // Update user - ONLY SET CANCELLATION FLAGS, KEEP isSubscription: true
    user.isSubscriptionCancelled = true; // ✅ SET CANCELLATION FLAG
    user.subscriptionCanceledAt = currentDate; // ✅ SET CANCELLATION DATE
    // ❌ DON'T CHANGE: user.isSubscription = true (service continues)
    await user.save();

    // ✅ UPDATE SUBSCRIPTION RECORD
    await Subscription.findOneAndUpdate(
      { stripeSubscriptionId: sub.id },
      {
        status: "cancel_scheduled", // Status change but service continues
        isSubscriptionCancelled: true, // ✅ SET CANCELLATION FLAG
        canceledAt: currentDate, // ✅ SET CANCELLATION DATE
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(canceled.current_period_end * 1000),
      }
    );

    // ✅ SINGLE LOG ENTRY
    await logSubscriptionLifecycle(
      'SUBSCRIPTION_CANCEL_REQUESTED',
      canceled,
      user,
      {
        apiSource: 'cancelSubscription',
        cancelAtPeriodEnd: canceled.cancel_at_period_end,
        currentPeriodEnd: new Date(canceled.current_period_end * 1000),
        userUpdated: {
          isSubscription: true, // ✅ SERVICE CONTINUES
          isSubscriptionCancelled: true, // ✅ CANCELLATION REQUESTED
          subscriptionCanceledAt: currentDate
        }
      }
    );

    return successResponse(res, "Subscription cancellation scheduled successfully. You can continue using the service until the end of your billing period.", {
      subscriptionId: canceled.id,
      cancelAtPeriodEnd: canceled.cancel_at_period_end,
      currentPeriodEnd: new Date(canceled.current_period_end * 1000),
      status: canceled.status,
      isSubscriptionCancelled: true, // ✅ CANCELLATION REQUESTED
      isSubscription: true, // ✅ SERVICE STILL ACTIVE
      userStatus: {
        isSubscription: true, // ✅ SERVICE CONTINUES
        isSubscriptionCancelled: true, // ✅ CANCELLATION REQUESTED
        subscriptionCanceledAt: currentDate,
        subscriptionEndDate: user.subscriptionEndDate, // Actual service end date
        daysRemaining: Math.ceil((new Date(canceled.current_period_end * 1000) - currentDate) / (1000 * 60 * 60 * 24))
      }
    });
  } catch (error) {
    console.error("❌ cancelSubscription error:", error);
    return errorResponse(res, "Error canceling subscription: " + error.message, 500);
  }
});

/**
 * @desc Get all subscriptions with Stripe details (admin only) - SIMPLIFIED
 * @route GET /api/subscription/admin/list
 */
export const getAllSubscriptionsAdmin = async (req, res) => {
  if (!req.user?.isAdmin) {
    return errorResponse(res, "Admin access required", 403);
  }

  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.perPage, 10) || 10, 1);
    const search = req.query.search ? req.query.search.trim() : "";
    const order = req.query.sort === "asc" ? 1 : -1;
    const skip = (page - 1) * limit;

    console.log(`📊 Admin subscriptions request: page=${page}, perPage=${limit}, search="${search}", sort="${req.query.sort}"`);

    // Build optimized query pipeline
    const pipeline = [
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      {
        $unwind: {
          path: "$user",
          preserveNullAndEmptyArrays: true,
        },
      },
    ];

    // ✅ Add search filter
    if (search) {
      const regex = new RegExp(search, "i");
      pipeline.push({
        $match: {
          $or: [
            { stripeSubscriptionId: regex },
            { stripeCustomerId: regex },
            { planType: regex },
            { status: regex },
            { "user.firstname": regex },
            { "user.lastname": regex },
            { "user.email": regex },
          ],
        }
      });
    }

    // ✅ Get total count first (for pagination)
    const countPipeline = [...pipeline, { $count: "total" }];
    const countResult = await Subscription.aggregate(countPipeline);
    const total = countResult[0]?.total || 0;

    // ✅ Get paginated data with sorting
    pipeline.push(
      { $sort: { createdAt: order } }, // Always sort by createdAt
      { $skip: skip },
      { $limit: limit }
    );

    const subscriptions = await Subscription.aggregate(pipeline);

    // ✅ Batch process Stripe data
    const optimizedSubscriptions = await Promise.all(
      subscriptions.map(async (sub) => {
        const user = sub.user || null;

        if (!sub.stripeSubscriptionId) {
          return formatSubscriptionResponse(sub, user, null, null, null, null);
        }

        try {
          const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId, {
            expand: ["latest_invoice", "default_payment_method"]
          });

          return formatSubscriptionResponse(
            sub,
            user,
            stripeSub,
            stripeSub.latest_invoice,
            stripeSub.default_payment_method,
            null
          );
        } catch (err) {
          console.warn(`⚠️ Stripe fetch failed for ${sub.stripeSubscriptionId}: ${err.message}`);
          return formatSubscriptionResponse(sub, user, null, null, null, null);
        }
      })
    );

    console.log(`✅ Admin subscriptions fetched: ${optimizedSubscriptions.length} of ${total}`);

    return successResponse(
      res,
      "All subscriptions fetched successfully",
      {
        subscriptions: optimizedSubscriptions,
        pagination: {
          currentPage: page,
          perPage: limit,
          totalPages: Math.ceil(total / limit),
          totalData: total,
          hasMore: page * limit < total,
          hasPrevPage: page > 1,
          hasNextPage: page < Math.ceil(total / limit)
        }
      }
    );
  } catch (error) {
    console.error("❌ getAllSubscriptionsAdmin error:", error);
    return errorResponse(res, "Error fetching subscriptions: " + error.message, 500);
  }
};

/**
 * @desc Get subscription by ID with all details + SIMPLE transaction history
 * @route GET /api/subscription/admin/:subscriptionId
 * @access Private (Admin)
 */
export const getSubscriptionById = asyncHandler(async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    if (!req.user?.isAdmin) {
      return errorResponse(res, "Admin access required", 403);
    }

    // Find in database for additional context
    const dbSubscription = await Subscription.findOne({
      stripeSubscriptionId: subscriptionId
    }).populate('userId');

    // Fetch from Stripe
    const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: [
        "latest_invoice",
        "latest_invoice.payment_intent",
        "default_payment_method",
        "items.data.price"
      ]
    });

    // Find user
    const user = dbSubscription?.userId
      ? await User.findById(dbSubscription.userId)
      : await User.findOne({ stripeCustomerId: stripeSubscription.customer });

    // ✅ SIMPLE: Get only SUCCESSFUL transactions
    let simpleTransactions = [];
    if (user?.stripeCustomerId) {
      const invoices = await stripe.invoices.list({
        customer: user.stripeCustomerId,
        subscription: subscriptionId, // Only invoices for this subscription
        limit: 50,
        status: 'paid', // ✅ ONLY PAID INVOICES
      });

      simpleTransactions = invoices.data.map(invoice => ({
        id: invoice.id,
        number: invoice.number,
        amount: invoice.amount_paid / 100, // Convert to dollars
        currency: invoice.currency.toUpperCase(),
        date: new Date(invoice.created * 1000).toISOString().split('T')[0], // Only date
        type: invoice.billing_reason === "subscription_cycle" ? "renewal" : "initial",
        receipt_url: invoice.hosted_invoice_url,
        status: 'completed'
      }));

      // Sort by date (newest first)
      simpleTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    // Extract data
    const latestInvoice = stripeSubscription.latest_invoice;
    const paymentMethod = stripeSubscription.default_payment_method;
    const price = stripeSubscription.items.data[0]?.price;

    // Format response using your existing formatter
    const subscription = formatSubscriptionResponse(
      dbSubscription || { stripeSubscriptionId: subscriptionId },
      user,
      stripeSubscription,
      latestInvoice,
      paymentMethod,
      price
    );

    return successResponse(res, "Subscription details with transaction history fetched successfully", {
      subscription: subscription,

      // ✅ SIMPLE: Clean transaction history
      transaction_history: simpleTransactions
    });

  } catch (error) {
    if (error.type === 'StripeInvalidRequestError' && error.code === 'resource_missing') {
      return errorResponse(res, "Subscription not found", 404);
    }
    return errorResponse(res, "Error fetching subscription: " + error.message, 500);
  }
});

/**
 * @desc Get user's subscriptions with SIMPLE transaction history (only successful payments)
 * @route GET /api/subscription/list?type=current|all
 * @access Private (User)
 */
export const getUserSubscriptions = asyncHandler(async (req, res) => {
  const { type } = req.query;
  const user = await User.findById(req.user.id);

  if (!user?.stripeCustomerId) {
    return res.status(404).json({
      success: false,
      message: "Stripe customer not found",
    });
  }

  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      expand: [
        "data.items.data.price",
        "data.latest_invoice",
        "data.default_payment_method"
      ],
      limit: 12,
      status: type === 'current' ? 'active' : 'all'
    });

    if (!subscriptions.data.length) {
      return res.status(404).json({
        success: false,
        message: "No subscriptions found for this user",
      });
    }

    // ✅ SIMPLE: Get only SUCCESSFUL transactions
    let simpleTransactions = [];
    try {
      const invoices = await stripe.invoices.list({
        customer: user.stripeCustomerId,
        limit: 50,
        status: 'paid', // ✅ ONLY PAID INVOICES
      });

      simpleTransactions = invoices.data.map(invoice => ({
        id: invoice.id,
        number: invoice.number,
        amount: invoice.amount_paid / 100, // Convert to dollars
        currency: invoice.currency.toUpperCase(),
        date: new Date(invoice.created * 1000).toISOString().split('T')[0], // Only date
        type: invoice.billing_reason === "subscription_cycle" ? "renewal" : "initial",
        receipt_url: invoice.hosted_invoice_url,
        subscription_id: invoice.subscription
      }));

      // Sort by date (newest first)
      simpleTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    } catch (invoiceError) {
      console.warn("⚠️ Could not fetch transaction history:", invoiceError.message);
    }

    // Format subscriptions
    const formattedSubscriptions = await Promise.all(
      subscriptions.data.map(async (sub) => {
        let productDetails = {};

        const price = sub.items.data[0]?.price;
        if (price?.product && typeof price.product === 'string') {
          try {
            const product = await stripe.products.retrieve(price.product);
            productDetails = {
              id: product.id,
              name: product.name,
              description: product.description,
              images: product.images,
            };
          } catch (error) {
            console.warn(`⚠️ Failed to fetch product ${price.product}:`, error.message);
          }
        }

        // ✅ SIMPLE: Filter transactions for this subscription
        const subscriptionTransactions = simpleTransactions.filter(
          t => t.subscription_id === sub.id
        );

        const subscriptionData = {
          stripeSubscriptionId: sub.id,
          status: sub.status,
          planType: describePlan(price).planType,
          amount: price?.unit_amount ? price.unit_amount / 100 : undefined,
          currency: price?.currency,
          startDate: new Date(sub.current_period_start * 1000),
          endDate: new Date(sub.current_period_end * 1000),
          currentPeriodStart: new Date(sub.current_period_start * 1000),
          currentPeriodEnd: new Date(sub.current_period_end * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end || false,
        };

        const formattedSubscription = formatSubscriptionResponse(
          subscriptionData,
          user,
          sub,
          sub.latest_invoice,
          sub.default_payment_method,
          price
        );

        // ✅ SIMPLE: Return only basic subscription info
        return formattedSubscription;
      })
    );

    // ✅ SIMPLE: Return clean response
    return successResponse(res,
      type === "current"
        ? "Current subscription fetched successfully"
        : "All subscriptions fetched successfully",
      {
        object: "list",
        data: formattedSubscriptions,
        has_more: subscriptions.has_more,
        url: `/v1/subscriptions?customer=${user.stripeCustomerId}`,

        // ✅ SIMPLE: Add transaction history separately
        transaction_history: simpleTransactions
      }
    );

  } catch (error) {
    console.error("❌ getUserSubscriptions error:", error);
    return errorResponse(res, "Failed to fetch subscriptions: " + error.message, 500);
  }
});

/**
 * @desc Verify payment intent and activate subscription - Flutter only
 * @route POST /api/subscription/success-payment
 * @access Private
 */
export const verifyCheckoutSession = async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const userId = req.user.id;

    console.log(`🔍 [FLUTTER_PAYMENT] Starting verification for user: ${userId}`);

    if (!paymentIntentId) {
      return errorResponse(res, "paymentIntentId is required", 400);
    }

    // ✅ REMOVE THE AUTO-CONFIRM BLOCK - JUST CHECK STATUS
    // Get user first
    const user = await User.findById(userId);
    if (!user) return errorResponse(res, "User not found", 404);

    // ✅ Retrieve payment intent to check status (ONLY RETRIEVE, DON'T CONFIRM)
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    console.log(`🔍 [FLUTTER_PAYMENT] Payment Intent Status: ${paymentIntent.status}`);

    // ✅ Check if payment is already succeeded
    if (paymentIntent.status !== 'succeeded') {
      return errorResponse(res, `Payment not completed. Status: ${paymentIntent.status}`, 400);
    }

    // ✅ FIND SUBSCRIPTION BY PAYMENT INTENT ID OR USER ID
    let subscriptionRecord = await Subscription.findOne({
      stripePaymentIntentId: paymentIntentId
    });

    // ✅ FALLBACK: If not found by paymentIntent, find by userId with pending status
    if (!subscriptionRecord) {
      subscriptionRecord = await Subscription.findOne({
        userId: userId,
        status: { $in: ["pending_payment", "in_progress"] }
      });
    }

    if (!subscriptionRecord) {
      return errorResponse(res, "No subscription found for this payment intent", 404);
    }

    // ✅ CHECK IF SUBSCRIPTION ALREADY ACTIVE (PREVENT DUPLICATE)
    if (subscriptionRecord.status === "active") {
      console.log(`ℹ️ Subscription already active: ${subscriptionRecord.stripeSubscriptionId}`);
      return successResponse(res, "Subscription already active", {
        subscription: {
          id: subscriptionRecord.stripeSubscriptionId,
          status: "active",
        }
      });
    }

    // ✅ Retrieve subscription (if it exists)
    let stripeSubscription;
    if (subscriptionRecord.stripeSubscriptionId) {
      stripeSubscription = await stripe.subscriptions.retrieve(
        subscriptionRecord.stripeSubscriptionId
      );
    } else {
      // If no subscription ID yet, check if one was created for this customer
      const subscriptions = await stripe.subscriptions.list({
        customer: user.stripeCustomerId,
        status: 'active',
        limit: 1
      });

      if (subscriptions.data.length > 0) {
        stripeSubscription = subscriptions.data[0];
        // Update the subscription record with the Stripe subscription ID
        subscriptionRecord.stripeSubscriptionId = stripeSubscription.id;
      } else {
        return errorResponse(res, "No active subscription found in Stripe", 404);
      }
    }

    // Get plan type
    const price = stripeSubscription.items.data[0]?.price;
    const { planType: detectedPlanType } = describePlan(price);

    console.log(`✅ [FLUTTER_PAYMENT] Activating subscription: ${stripeSubscription.id}`);

    // ✅ UPDATE USER SUBSCRIPTION
    user.isSubscription = true;
    user.subscriptionType = detectedPlanType;
    user.subscriptionStartDate = new Date(stripeSubscription.current_period_start * 1000);
    user.subscriptionEndDate = new Date(stripeSubscription.current_period_end * 1000);
    await user.save();

    // ✅ UPDATE SUBSCRIPTION RECORD
    await Subscription.findOneAndUpdate(
      { _id: subscriptionRecord._id },
      {
        status: "active",
        stripeSubscriptionId: stripeSubscription.id,
        startDate: new Date(stripeSubscription.current_period_start * 1000),
        endDate: new Date(stripeSubscription.current_period_end * 1000),
        activatedAt: new Date(),
      }
    );

    // ✅ LOGGING AND NOTIFICATION
    await logSubscriptionLifecycle(
      'PAYMENT_INTENT_VERIFIED',
      {
        paymentIntentId,
        subscriptionId: stripeSubscription.id,
        planType: detectedPlanType
      },
      user,
      { apiSource: 'success-payment' }
    );

    await notifyUser(
      user,
      "Subscription Activated 🎉",
      `Your ${detectedPlanType} subscription is now active! Auto-renewal is enabled.`,
      {
        deeplink: "/subscription",
        data: {
          action: "subscription_activated",
          subscriptionId: stripeSubscription.id,
          planType: detectedPlanType
        },
      }
    );

    console.log(`✅ [FLUTTER_PAYMENT] Subscription activated via payment intent: ${stripeSubscription.id}`);

    return successResponse(res, "Subscription activated successfully!", {
      subscription: {
        id: stripeSubscription.id,
        status: "active",
        planType: detectedPlanType,
        startDate: new Date(stripeSubscription.current_period_start * 1000),
        endDate: new Date(stripeSubscription.current_period_end * 1000),
        isAutoRenew: true,
      },
      user: {
        isSubscription: true,
        subscriptionType: detectedPlanType,
      }
    });

  } catch (error) {
    console.error("❌ [FLUTTER_PAYMENT] Error:", error);

    if (error.code === 11000) {
      console.log('🔄 Duplicate subscription detected, fetching existing record');
      const existingSub = await Subscription.findOne({
        stripeSubscriptionId: error.keyValue.stripeSubscriptionId
      });

      if (existingSub) {
        return successResponse(res, "Subscription already active", {
          subscription: {
            id: existingSub.stripeSubscriptionId,
            status: existingSub.status,
            planType: existingSub.planType,
          }
        });
      }
    }

    return errorResponse(res, "Payment verification failed: " + error.message, 500);
  }
};

/**
 * @desc Get all transactions for a specific user by user ID (Admin only) - Enhanced Version
 * @route GET /api/subscription/admin/user/:userId/transactions
 * @access Private (Admin)
 */
export const getUserTransactionsAdmin = asyncHandler(async (req, res) => {
  try {
    const { userId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (!req.user?.isAdmin) {
      return errorResponse(res, "Admin access required", 403);
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, "User not found", 404);
    }

    if (!user.stripeCustomerId) {
      return successResponse(res, "User has no Stripe transactions", {
        transactions: [],
        user: {
          id: user._id,
          email: user.email,
          name: `${user.firstname} ${user.lastname}`,
          stripeCustomerId: null
        },
        statusSummary: {
          active: 0,
          inactive: 0,
          inactiveBreakdown: {
            unpaid: 0,
            draft: 0,
            failed: 0,
            in_progress: 0,
            void: 0,
            others: 0
          }
        }
      });
    }

    // Fetch all invoices for the customer
    const invoices = await stripe.invoices.list({
      customer: user.stripeCustomerId,
      limit: 100,
    });

    // Status counters
    let activeCount = 0;
    let inactiveCount = 0;
    const inactiveBreakdown = {
      unpaid: 0,      // open status, not paid
      draft: 0,       // draft status
      failed: 0,      // status failed or payment failed
      in_progress: 0, // processing, pending
      void: 0,        // void status
      others: 0       // any other status
    };

    const transactions = await Promise.all(
      invoices.data.map(async (invoice) => {
        // Get subscription details if available
        let subscriptionDetails = null;
        if (invoice.subscription) {
          try {
            const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
            const price = subscription.items.data[0]?.price;
            const { planType } = describePlan(price);

            subscriptionDetails = {
              id: subscription.id,
              status: subscription.status,
              planType: planType,
              currentPeriodEnd: subscription.current_period_end,
            };
          } catch (error) {
            console.warn(`Could not fetch subscription ${invoice.subscription}:`, error.message);
          }
        }

        // Enhanced status detection
        let isActive = false;
        let detailedStatus = invoice.status;

        if (invoice.status === 'paid' && invoice.paid === true) {
          isActive = true;
          activeCount++;
        } else {
          isActive = false;
          inactiveCount++;

          // Detailed inactive status categorization
          switch (invoice.status) {
            case 'draft':
              inactiveBreakdown.draft++;
              detailedStatus = 'draft';
              break;
            case 'open':
              inactiveBreakdown.unpaid++;
              detailedStatus = 'unpaid';
              break;
            case 'void':
              inactiveBreakdown.void++;
              detailedStatus = 'void';
              break;
            case 'uncollectible':
              inactiveBreakdown.failed++;
              detailedStatus = 'failed';
              break;
            default:
              if (!invoice.paid && invoice.attempted) {
                inactiveBreakdown.failed++;
                detailedStatus = 'failed';
              } else if (!invoice.paid && !invoice.attempted) {
                inactiveBreakdown.in_progress++;
                detailedStatus = 'in_progress';
              } else {
                inactiveBreakdown.others++;
                detailedStatus = invoice.status;
              }
          }
        }

        return {
          id: invoice.id,
          type: 'invoice',
          number: invoice.number,
          amount_due: invoice.amount_due,
          amount_paid: invoice.amount_paid,
          amount_remaining: invoice.amount_remaining,
          currency: invoice.currency.toUpperCase(),
          status: invoice.status,
          detailedStatus: detailedStatus, // Enhanced status field
          created: invoice.created,
          date: new Date(invoice.created * 1000).toISOString(),
          paid: invoice.paid,
          attempted: invoice.attempted,
          receipt_url: invoice.hosted_invoice_url,
          invoice_pdf: invoice.invoice_pdf,
          subscription_id: invoice.subscription,
          payment_intent: invoice.payment_intent,
          subscription: subscriptionDetails,
          isActive: isActive
        };
      })
    );

    // Sort by date (newest first)
    transactions.sort((a, b) => b.created - a.created);

    // Paginate
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTransactions = transactions.slice(startIndex, endIndex);

    return successResponse(res, "User transactions fetched successfully", {
      transactions: paginatedTransactions,
      pagination: {
        currentPage: page,
        perPage: limit,
        totalPages: Math.ceil(transactions.length / limit),
        totalData: transactions.length,
        hasMore: endIndex < transactions.length
      },
      user: {
        id: user._id,
        email: user.email,
        name: `${user.firstname} ${user.lastname}`,
        stripeCustomerId: user.stripeCustomerId,
        isSubscription: user.isSubscription,
        subscriptionType: user.subscriptionType,
      },
      summary: {
        total_transactions: transactions.length,
        total_amount_paid: transactions.reduce((sum, t) => sum + (t.amount_paid || 0), 0),
        currency: 'USD'
      },
      statusSummary: {
        active: activeCount,
        inactive: inactiveCount,
        inactiveBreakdown: inactiveBreakdown,
        // Additional calculated fields
        successRate: transactions.length > 0 ? Math.round((activeCount / transactions.length) * 100) : 0,
        failureRate: transactions.length > 0 ? Math.round((inactiveBreakdown.failed / transactions.length) * 100) : 0
      }
    });

  } catch (error) {
    console.error("❌ getUserTransactionsAdmin error:", error);
    return errorResponse(res, "Error fetching user transactions: " + error.message, 500);
  }
});
