const Order = require("../../database/dbModels/Order");
const { saveToStorage } = require("../../database/databaseUtils");
const { postSlackMessageWithRetry } = require("../../Handlers/slackApiUtils");
const { checkFormErrors } = require("../aiService");

// Validation helpers
async function validateOrderDate(formData, channelId, slackToken, context) {
	const selectedDate = formData.request_date?.input_request_date?.selected_date;
	const selectedDateObj = new Date(selectedDate);
	const todayObj = new Date();
	selectedDateObj.setHours(0, 0, 0, 0);
	todayObj.setHours(0, 0, 0, 0);

	if (!selectedDate || selectedDateObj < todayObj) {
		try {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: channelId,
					text: "⚠️ *Erreur*: La date sélectionnée est dans le passé. Veuillez rouvrir le formulaire et sélectionner une date d'aujourd'hui ou future.",
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "⚠️ *Erreur*: La date sélectionnée est dans le passé.",
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "Veuillez créer une nouvelle commande et sélectionner une date d'aujourd'hui ou future.",
							},
						},
					],
				},
				slackToken
			);
			context.log("Error notification sent to user");
		} catch (error) {
			context.log(`Failed to send error notification: ${error}`);
		}

		return {
			isValid: false,
			response: {
				response_action: "errors",
				errors: {
					request_date: "La date ne peut pas être dans le passé",
				},
			},
		};
	}

	return { isValid: true };
}
async function performErrorChecking(
	formData,
	userId,
	payload,
	existingMetadata,
	context
) {
	const pastOrders = await Order.find({ demandeur: userId }).limit(5);
	const { errors } = await checkFormErrors(formData, pastOrders, context);

	if (errors.length > 0) {
		const formDataKey = `form_${payload.view.id}_${Date.now()}`;

		// const simpleErrorBlocks = [
		// 	{
		// 		type: "section",
		// 		text: {
		// 			type: "mrkdwn",
		// 			text: "⚠️ *Erreurs détectées dans votre commande*",
		// 		},
		// 	},
		// 	...Object.entries(errors).map(([field, message]) => ({
		// 		type: "section",
		// 		text: {
		// 			type: "mrkdwn",
		// 			text: `*-* ${message}`,
		// 		},
		// 	})),
		// 	{
		// 		type: "actions",
		// 		block_id: "error_actions",
		// 		elements: [
		// 			{
		// 				type: "button",
		// 				text: { type: "plain_text", text: "Corriger" },
		// 				action_id: "return_to_form",
		// 				value: JSON.stringify({
		// 					viewId: payload.view.id,
		// 					formDataKey: formDataKey,
		// 				}),
		// 			},
		// 		],
		// 	},
		// ];

		await saveToStorage(formDataKey, payload.view.state.values);

		return {
			hasErrors: true,
			response: await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: userId,
					text: `⚠️ Une erreur est survenue. Veuillez réessayer.\n❌ Erreurs:\n- ${errors.join(
						"\n- "
					)}`,
				},
				process.env.SLACK_BOT_TOKEN
			),
		};
	}

	return { hasErrors: false };
}
module.exports = {
	validateOrderDate,
	performErrorChecking,
};
