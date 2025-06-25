const {
	handleProformaValidationRequest,
	proforma_form,
	validateProforma,
	handleEditProforma,
	handleDeleteProformaConfirmation,
} = require("../services/proformaService");

const {
	handleDeleteOrderConfirmed,
	OpenForm,
	editOrder,
	view_order,
	handleDynamicFormUpdates,
} = require("../services/Order/orderInteractionHandler");
const {
	handleEditPayment,
} = require("../services/Payment/paymentRequestService");
const { notifyFinancePayment } = require("../services/Notifications/Payment");
const {
	ReturnToForm,
	handleDeleteOrderCanceled,
} = require("../services/Order/orderFormHandler");
const {
	generateFundingApprovalPaymentModal,
} = require("../services/Payment/blockBuilder");
const {
	openRejectionReasonModalFund,
} = require("../services/caisse/blockBuilders");
const {
	PaymentRejection,
	handleReportProblemWithNotification,
	handleReportProblem,
	RejectPayment,
} = require("../services/Payment/paymentModalService");
const { PaymentForm } = require("../services/Payment/paymentFormService");
const {
	handleCorrectFundingDetails,
} = require("../services/caisse/correctionService");
const {
	openFinalApprovalConfirmationDialog,
	handleApproveFunding,
	openPreApprovalConfirmationDialog,
} = require("../services/caisse/approvalService");
const { FundsForm } = require("../services/caisse/fundingRequestService");
const {
	handleOrderAcceptReject,
	handleDeleteOrder,
} = require("../services/Order/orderFormHandler");
const {
	handleFinancePaymentForm,
	handlePaymentModificationSubmission,
	handlePaymentMethodSelection,
} = require("../services/Payment/paymentProcessingService");
const {
	handleConfirmPaymentMode,
	handleConfirmPaymentMode2,
} = require("../services/Payment/paymentFormService");
const { openRejectionReasonModal } = require("../services/Order/blockBuilders");
const { createSlackResponse } = require("./slackApiUtils");
const PaymentRequest = require("../database/dbModels/PaymentRequest");

async function handleBlockActions(payload, context) {
	try {
		context.log("** handleBlockActions");

		// Validate payload structure
		if (!payload?.actions?.[0]) {
			context.log("Invalid payload: missing actions");
			return createSlackResponse(400, "Invalid payload structure");
		}

		const action = payload.actions[0];
		const actionId = action.action_id;
		const userName = payload.user?.username;
		const paymentId = action.value;

		context.log(`Processing action: ${actionId} by user: ${userName}`);
		context.log(`Payload type: ${payload.type}`);

		// Early returns for specific action types
		if (actionId === "edit_order") {
			context.log("** Processing edit_order");
			await editOrder(payload, context);
			return createSlackResponse(200, "");
		}

		if (actionId === "edit_payment") {
			return await handleEditPayment(payload, context);
		}

		if (actionId === "return_to_form") {
			await ReturnToForm(payload, context);
			return createSlackResponse(200, "");
		}
		if (actionId === "fill_funding_details") {
			console.log("**3 fill_funding_details");
			console.log("Message TS:", payload.message?.ts);
			console.log("Channel ID:", payload.channel?.id);
			// Immediate response to close modal
			context.res = {
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ response_action: "clear" }),
			};

			// Process in background
			setImmediate(async () => {
				console.log("approve_funding");
				const messageTs = payload.message?.ts;
				const channelId = payload.channel?.id; // Get the current channel ID

				console.log("Processing fill_funding_details");
				console.log(`Message TS: ${messageTs}, Channel ID: ${channelId}`);

				const requestId = action.value; // e.g., FUND/2025/04/0070

				await generateFundingApprovalPaymentModal(
					context,
					payload.trigger_id,
					messageTs,
					requestId,
					channelId
				);
				return createSlackResponse(200, "");
			});

			return context.res;
		}
		if (actionId === "input_payment_method") {
			console.log("Handling payment method selection");
			await handlePaymentMethodSelection(payload, context);
			return createSlackResponse(200, "");
		}
		if (actionId === "process_delayed_order") {
			// return await handleDelayedOrderAction(payload, action, context);
			return console.log("** process_delayed_order action triggered");
		}
		if (actionId === "process_delayed_order") {
			// return await handleDelayedOrderAction(payload, action, context);
			return console.log("** process_delayed_order action triggered");
		}
		if (actionId === "accept_payment") {
			const paymentRequest = await PaymentRequest.findOneAndUpdate(
				{ id_paiement: paymentId },
				{ statut: "Validé", autorisation_admin: true, updatedAt: new Date() },
				{ new: true }
			);
			console.log("paymentRequest1", paymentRequest);

			await notifyFinancePayment(paymentRequest, context, userName);
			// Update Slack message (e.g., via chat.update)
			return { statusCode: 200, body: "" };
		}
		if (actionId === "reject_payment") {
			console.log("** reject_payment");
			await RejectPayment(payload, context);
		}
		// Handle different payload types
		switch (payload.type) {
			case "interactive_message":
				return await handleInteractiveMessage(payload, action, context);

			case "dialog_submission":
				return await handleDialogSubmission(payload, context);

			case "block_actions":
				return await handleBlockActionsByType(payload, action, context);

			default:
				// Handle legacy return_to_form check
				if (payload.actions?.[0]?.action_id === "return_to_form") {
					// await ReturnToForm2(payload, context);
					return console.log("** return_to_form action triggered");
					// return createSlackResponse(200, "");
				}

				context.log(`Unsupported payload type: ${payload.type}`);
				return createSlackResponse(400, "Type d'action non supporté");
		}
	} catch (error) {
		context.log(`❌ Error in handleBlockActions: ${error.message}`);
		context.log(`Stack trace: ${error.stack}`);

		return createSlackResponse(500, {
			response_type: "ephemeral",
			text: "Une erreur s'est produite lors du traitement de votre demande.",
		});
	}
}

// Helper function to handle interactive messages
async function handleInteractiveMessage(payload, action, context) {
	context.log("** Processing interactive_message");

	if (action.value !== "open") {
		return createSlackResponse(400, "Invalid interactive message action");
	}

	switch (action.name) {
		case "open_form":
			return await OpenForm(payload, context);

		case "finance_payment_form":
			// Acknowledge immediately, process asynchronously
			setImmediate(async () => {
				try {
					await PaymentForm(payload, context);
				} catch (error) {
					context.log(`Error in finance_payment_form: ${error.message}`);
				}
			});

			return createSlackResponse(200, "");

		default:
			return createSlackResponse(400, "Unknown interactive message action");
	}
}

// Helper function to handle dialog submissions
async function handleDialogSubmission(payload, context) {
	context.log("** Processing dialog_submission");

	const callbackId = payload.callback_id;

	switch (callbackId) {
		case "delete_order_confirm":
			return await handleDeleteOrderConfirmed(payload, context);

		default:
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "Action de dialogue non reconnue.",
			});
	}
}

// Helper function to handle block actions by specific action ID
async function handleBlockActionsByType(payload, action, context) {
	context.log("** Processing block_actions");

	const actionId = action.action_id;
	console.log(`Action ID: ${actionId}`);
	// Handle view_order actions
	if (actionId.startsWith("view_order_")) {
		return await view_order(payload, action, context);
	}

	// Main switch for all other actions
	switch (actionId) {
		// Funding related actions
		case "correct_funding_details":
			return await handleCorrectFundingDetails(payload, action, context);

		case "funding_approval_payment":
			await openFinalApprovalConfirmationDialog(payload);
			return createSlackResponse(200, "");

		case "open_funding_form":
			return await FundsForm(payload, context);

		case "approve_funding":
			return await handleApproveFunding(payload, action, context);

		case "pre_approve_funding":
			await openPreApprovalConfirmationDialog(payload);
			return createSlackResponse(200, "");

		case "reject_fund":
			return openRejectionReasonModalFund(payload, action.value);

		// Payment verification actions
		case "payment_verif_accept":
		case "payment_verif_reject":
			console.log(
				"** payment_verif_accept or payment_verif_reject action triggered"
			);
			return await PaymentRejection(payload, action, context);

		// Order actions
		case "accept_order":
			return await handleOrderAcceptReject(payload, action, context);
		case "reject_order":{
			let paymentId = action.value;
			console.log("Rejecting order", paymentId);
			return openRejectionReasonModal(payload, paymentId);
		}
		// case "reopen_order":
		// 	return await reopenOrder(payload, action, context);

		case "delete_order":
			return await handleDeleteOrder(payload, context);

		case "delete_order_confirmed":
			return await handleDeleteOrderConfirmed(payload, context);

		case "delete_order_canceled":
			return await handleDeleteOrderCanceled(payload, context);

		// Payment form actions
		case "finance_payment_form":
			return await handleFinancePaymentForm(payload, action, context);

		case "confirm_payment_mode":
			return await handleConfirmPaymentMode(payload, context);

		case "confirm_payment_mode_2":
			return await handleConfirmPaymentMode2(payload, context);

		case "Modifier_paiement":
		case "modify_payment":
			return await handlePaymentModificationSubmission(payload, context);

		case "mode_input":
			return console.log("** mode_input action triggered");
		// return await handlePaymentModeSelection(payload, context);

		// Proforma actions
		case "confirm_validate_proforma":
			return await handleProformaValidationRequest(payload, context);

		case "proforma_form":
			return await proforma_form(payload, context);

		case "validate_proforma":
			return await validateProforma(payload, context);

		case "edit_proforma":
			return await handleEditProforma(payload, context);

		case "confirm_delete_proforma":
			return await handleDeleteProformaConfirmation(payload, context);

		// case "confirm_validate_proforma":
		// return await handleValidateProforma(payload, context);

		// Validation actions
		case "approve_1":
			return console.log("** approve_1 action triggered");
		// await handleValidationRequest(payload, context);
		// return createSlackResponse(200, "");

		case "delete_confirmation":
			return console.log("** delete_confirmation action triggered");
		// return await cancelValidation(payload, context);

		// Problem reporting
		case "report_problem":
			return await handleReportProblemWithNotification(payload, context);

		case "report_fund_problem":
			return await handleReportProblem(
				payload,
				context,
				payload.container?.message_ts
			);

		default:
			return await handleDynamicFormUpdates(payload, action, context);
	}
}

module.exports = {
	handleBlockActions,
};
