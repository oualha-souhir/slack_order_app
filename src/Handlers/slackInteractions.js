const {
	handleRejectionReasonSubmission,
} = require("../services/Order/orderFormHandler");
const {
	handleFinanceDetailsSubmission,
} = require("../services/caisse/paymentService");
const { handleBlockActions } = require("./blockActions");
const {
	createSlackResponse,
	verifySlackSignature,
	postSlackMessageWithRetry,
} = require("./slackApiUtils");
const {
	handlePreApprovalConfirmation,
	handleFinalApprovalConfirmation,
} = require("../services/caisse/approvalService");
const {
	handleProformaValidationConfirm,
} = require("../services/proformaService");
const {
	handlePaymentVerificationConfirm,
} = require("../services/Payment/paymentRequestService");
const { handleViewSubmission } = require("./ViewSubmissionz");

let payload;

const VIEW_SUBMISSION_HANDLERS = {
	pre_approval_confirmation_submit: handlePreApprovalConfirmation,
	final_approval_confirmation_submit: handleFinalApprovalConfirmation,
	submit_finance_details: handleFinanceDetailsSubmission,
	proforma_validation_confirm: handleProformaValidationConfirm,
	payment_verif_confirm: handlePaymentVerificationConfirm,
	rejection_reason_modal: handleRejectionReasonSubmission,
};

async function handleSlackInteractions(request, context) {
	console.log("** handleSlackInteractions");
	context.log("🔄 Interaction Slack reçue !");

	try {
		// Validate request signature
		const body = await request.text();
		if (!verifySlackSignature(request, body)) {
			return createSlackResponse(401, "Signature invalide");
		}

		// Parse payload
		const params = new URLSearchParams(body);
		const payload = JSON.parse(params.get("payload"));
		context.log(`📥 Payload reçu : ${JSON.stringify(payload)}`);

		// Route to appropriate handler
		switch (payload.type) {
			case "view_submission":
				return await handleViewSubmissionRouter(payload, context);

			case "block_actions":
			case "interactive_message":
				return await handleBlockActions(payload, context);

			default:
				return createSlackResponse(400, "Type d'interaction non supporté");
		}
	} catch (error) {
		return await handleGlobalError(error, context, payload);
	}
}

async function handleViewSubmissionRouter(payload, context) {
	context.log("** handleViewSubmissionRouter");

	const callbackId = payload.view.callback_id;
	const handler = VIEW_SUBMISSION_HANDLERS[callbackId];

	if (handler) {
		return await handler(payload, context);
	}

	// Default handler for unmatched callback IDs
	const response = await handleViewSubmission(payload, context);
	return response;
}

async function handleGlobalError(error, context, payload) {
	context.log(`❌ Erreur globale: ${error.stack}`);

	if (payload?.user?.id) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_tech_CHANNEL_ID,
				user: payload.user.id,
				text: `❌ Erreur globale: ${error.stack}`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}

	return createSlackResponse(500, "Erreur interne du serveur");
}

module.exports = { handleSlackInteractions };
