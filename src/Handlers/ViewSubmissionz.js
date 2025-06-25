const {
	handleRejectFundingSubmission,
} = require("../services/caisse/approvalService");
const {
	handleProblemSubmission,
} = require("../services/caisse/correctionService");
const {
	handleFundingRequestSubmission,
} = require("../services/caisse/fundingRequestService");
const {
	handleFundingApprovalSubmission,
} = require("../services/caisse/paymentService");
const {
	handleDeleteOrderSubmission,
	handleOrderFormSubmission,
} = require("../services/Order/orderFormHandler");
const { getChannelName } = require("../services/Order/orderHelpers");
const {
	handlePaymentFormSubmission,
} = require("../services/Payment/paymentFormService");
const {
	handlePaymentProblemSubmission,
} = require("../services/Payment/paymentModalService");
const {
	handlePaymentModificationSubmission,
} = require("../services/Payment/paymentProcessingService");
const {
	handlePaymentRequestSubmission,
} = require("../services/Payment/paymentRequestService");
const {
	handleProformaSubmission,
	handleEditProformaSubmission,
	handleDeleteProforma,
} = require("../services/proformaService");
const { createSlackResponse } = require("./slackApiUtils");

async function handleViewSubmission(payload, context) {
	console.log("** handleViewSubmission");

	// Extract common variables
	const { formData, userId, userName, callbackId } = extractCommonData(payload);
	const slackToken = process.env.SLACK_BOT_TOKEN;

	// Parse metadata
	const existingMetadata = parseMetadata(payload.view.private_metadata);
	const channelId = existingMetadata.channelId;
	const orderId = existingMetadata.orderId;

	// Get channel information
	const channelName = await getChannelName(channelId, context);

	// Route to specific handler based on callback_id
	const handler = getSubmissionHandler(callbackId);
	if (!handler) {
		return createSlackResponse(200, { text: "Submission non reconnue" });
	}

	return await handler({
		payload,
		context,
		formData,
		userId,
		userName,
		slackToken,
		existingMetadata,
		channelId,
		channelName,
		orderId,
	});
} // Helper functions
function extractCommonData(payload) {
	return {
		formData: payload.view.state.values,
		userId: payload.user.id,
		userName: payload.user.username,
		callbackId: payload.view.callback_id,
	};
}

function parseMetadata(privateMetadata) {
	return privateMetadata ? JSON.parse(privateMetadata) : {};
}
function getSubmissionHandler(callbackId) {
	console.log(`** getSubmissionHandler: ${callbackId}`);
	const handlers = {
		payment_modif_submission: handlePaymentModifSubmissionWrapper,
		correct_fund: handleCorrectFundSubmission,
		submit_cheque_details: handleChequeDetailsSubmission,
		reject_funding: handleRejectFundingSubmission,
		delete_order_confirmation: handleDeleteOrderSubmission,
		order_form_submission: handleOrderFormSubmission,
		submit_funding_request: handleFundingRequestSubmission,
		approve_funding_request: handleFundingApprovalSubmission,
		payment_form_submission: handlePaymentFormSubmission,
		payment_problem_submission: handlePaymentProblemSubmission,
		fund_problem_submission: handleProblemSubmission,
		payment_modification_submission: handlePaymentModificationSubmission,
		proforma_submission: handleProformaSubmission,
		edit_proforma_submission: handleEditProformaSubmission,
		delete_proforma_confirmation: handleDeleteProforma,
		payment_request_submission: handlePaymentRequestSubmission,
	};

	return handlers[callbackId];
}

// Individual submission handlers
async function handlePaymentModifSubmissionWrapper(params) {
	const { payload, context } = params;

	// Immediate response to close modal
	const response = createImmediateResponse();

	// Process in background
	setImmediate(async () => {
		await handlePaymentModifSubmission(payload, context);
	});

	return response;
}
async function handleCorrectFundSubmission(params) {
	const { payload, context, slackToken } = params;

	const response = createImmediateResponse();

	await postSlackMessage(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		},
		slackToken
	);

	setImmediate(async () => {
		console.log("** correct_fund");
		await handleCorrectionSubmission(payload, context);
	});

	return response;
}

async function handleChequeDetailsSubmission(params) {
	const { payload, userName } = params;

	const requestId = payload.view.private_metadata;
	const chequeNumber =
		payload.view.state.values.cheque_number.input_cheque_number.value;
	const bankName =
		payload.view.state.values.bank_name?.input_bank_name?.value || "";

	const chequeDetails = {
		number: chequeNumber,
		bank: bankName,
		date: new Date().toISOString(),
	};

	await processFundingApproval(
		requestId,
		"approve_cheque",
		userName,
		chequeDetails
	);
	return createSlackResponse(200, "");
}
module.exports = {
	handleViewSubmission,
	extractCommonData,
	parseMetadata,
	getSubmissionHandler,
	handlePaymentModifSubmissionWrapper,
	handleCorrectFundSubmission,
	handleChequeDetailsSubmission,
};
