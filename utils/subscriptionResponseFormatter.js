// utils/subscriptionResponseFormatter.js

import { describePlan } from "../controller/stripeController.js";

/**
 * Common formatter for subscription responses - Simplified version
 */
export const formatSubscriptionResponse = (subscription, user, stripeSub, latestInvoice, paymentMethod, price) => {
  const planInfo = describePlan(price);
  
  // User information
  const userName = user
    ? `${user.firstname || ""} ${user.lastname || ""}`.trim() || user.email || null
    : null;
  const userMobile = user && (user.mobile || user.phone || user.phoneNumber || user.contactNumber) 
    ? String(user.mobile || user.phone || user.phoneNumber || user.contactNumber)
    : null;

  return {
    // Subscription identifiers
    id: stripeSub?.id || subscription.stripeSubscriptionId,
    object: "subscription",
    subscriptionId: subscription.stripeSubscriptionId,
    subscriptionDbId: subscription._id?.toString(),
    customerId: subscription.stripeCustomerId,
    
    // Subscription status
    status: stripeSub?.status || subscription.status || null,
    cancelAtPeriodEnd: stripeSub?.cancel_at_period_end ?? subscription.cancelAtPeriodEnd ?? false,
    canceled_at: stripeSub?.canceled_at ? new Date(stripeSub.canceled_at * 1000).toISOString() : null,
    
    // Billing period
    current_period_start: stripeSub?.current_period_start ? new Date(stripeSub.current_period_start * 1000).toISOString() : null,
    current_period_end: stripeSub?.current_period_end ? new Date(stripeSub.current_period_end * 1000).toISOString() : null,
    start_date: stripeSub?.start_date ? new Date(stripeSub.start_date * 1000).toISOString() : null,
    
    // Plan details - flattened
    plan_type: planInfo.planType !== "unknown" ? planInfo.planType : subscription.planType || null,
    plan_label: planInfo.planLabel,
    plan_nickname: price?.nickname || null,
    amount: subscription.amount ?? (price?.unit_amount ? price.unit_amount / 100 : null),
    currency: subscription.currency || price?.currency || null,
    interval: price?.recurring?.interval || null,
    interval_count: price?.recurring?.interval_count || 1,
    product_id: price?.product ? (typeof price.product === 'object' ? price.product.id : price.product) : null,
    
    // Period dates
    period_start: subscription.startDate ? new Date(subscription.startDate).toISOString() : null,
    period_end: subscription.endDate ? new Date(subscription.endDate).toISOString() : null,
    
    // User information - flattened
    user_id: user?._id?.toString() || null,
    user_name: userName,
    user_email: user?.email || null,
    user_mobile: userMobile,
    
    // Invoice details - flattened
    invoice_id: latestInvoice?.id || subscription.latestInvoiceId || null,
    invoice_status: latestInvoice?.status || null,
    invoice_amount_paid: latestInvoice?.amount_paid != null ? latestInvoice.amount_paid / 100 : null,
    invoice_amount_due: latestInvoice?.amount_due != null ? latestInvoice.amount_due / 100 : null,
    invoice_currency: latestInvoice?.currency || subscription.currency || null,
    hosted_invoice_url: latestInvoice?.hosted_invoice_url || latestInvoice?.invoice_pdf || null,
    invoice_pdf: latestInvoice?.invoice_pdf || null,
    invoice_created: latestInvoice?.created ? new Date(latestInvoice.created * 1000).toISOString() : null,
    
    // Payment intent details
    payment_intent_id: latestInvoice?.payment_intent?.id || null,
    payment_intent_amount: latestInvoice?.payment_intent?.amount ? latestInvoice.payment_intent.amount / 100 : null,
    payment_intent_currency: latestInvoice?.payment_intent?.currency || null,
    payment_intent_status: latestInvoice?.payment_intent?.status || null,
    confirmation_method: latestInvoice?.payment_intent?.confirmation_method || null,
    capture_method: latestInvoice?.payment_intent?.capture_method || null,
    automatic_payment_methods: latestInvoice?.payment_intent?.automatic_payment_methods || null,
    payment_method_types: latestInvoice?.payment_intent?.payment_method_types || null,
    
    // Payment method details - flattened
    payment_method_id: paymentMethod?.id || null,
    payment_method_type: paymentMethod?.type || null,
    card_brand: paymentMethod?.card?.brand || null,
    card_last4: paymentMethod?.card?.last4 || null,
    card_exp_month: paymentMethod?.card?.exp_month || null,
    card_exp_year: paymentMethod?.card?.exp_year || null,
    
    // Additional details
    has_autopay: stripeSub?.collection_method === 'charge_automatically',
    
    // Timestamps
    created: stripeSub?.created ? new Date(stripeSub.created * 1000).toISOString() : null,
    createdAt: subscription.createdAt ? new Date(subscription.createdAt).toISOString() : null,
    updatedAt: subscription.updatedAt ? new Date(subscription.updatedAt).toISOString() : null,
  };
};