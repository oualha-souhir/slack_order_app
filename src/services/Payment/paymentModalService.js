const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const { getPaymentBlocks } = require("../Order/blockBuilders");
const { getProblemTypeText } = require("./blockBuilder");
const Caisse = require("../../database/dbModels/Caisse");
const { fetchEntity } = require("../../database/databaseUtils");
const { getBankInitialOption } = require("./paymentFormService");
const Order = require("../../database/dbModels/Order");
const { bankOptions } = require("../../Handlers/Utils");
const PaymentRequest = require("../../database/dbModels/PaymentRequest");

// Updated edit_payment handler to use the corrected function
async function handleModifyPayment(
	payload,
	context,
	selectedPaymentMode = null
) {
	console.log("** handleModifyPayment");
	try {
		let actionValue;
		// Determine if this is triggered by "confirm_payment_mode_2" or an initial action
		if (
			payload.actions &&
			payload.actions[0]?.action_id === "confirm_payment_mode_2"
		) {
			// For "Ajouter les détails" button, use private_metadata
			actionValue = JSON.parse(payload.view.private_metadata || "{}");
		} else {
			// For initial action, use actions[0].value
			actionValue = JSON.parse(payload.actions[0]?.value || "{}");
		}

		const {
			entityId,
			paymentIndex,
			problemType,
			problemDescription,
			reporterId,
		} = actionValue;
		console.log("problemType", problemType);

		// Fetch the entity
		const entity = await fetchEntity(entityId, context);
		if (!entity) {
			throw new Error(`Entity ${entityId} not found`);
		}

		// Get payment data

		const paymentData = entity.payments[paymentIndex];
		const details = paymentData.details || {};

		// Determine the payment mode to use
		const paymentMode =
			selectedPaymentMode ||
			paymentData.paymentMode ||
			paymentData.mode ||
			"Chèque";

		// Create blocks for existing payment proofs
		const proofsBlocks = [];
		if (paymentData.paymentProofs?.length > 0) {
			proofsBlocks.push({
				type: "section",
				block_id: "existing_proofs_header",
				text: {
					type: "mrkdwn",
					text: "*Justificatifs de paiement existants:*",
				},
			});
			paymentData.paymentProofs.forEach((proofUrl, index) => {
				const isFile =
					proofUrl.startsWith("https://files.slack.com") ||
					proofUrl.includes("slack-files");
				proofsBlocks.push({
					type: "input",
					block_id: `existing_proof_${index}`,
					optional: true,
					label: {
						type: "plain_text",
						text: isFile ? `📎 Fichier ${index + 1}` : `🔗 URL ${index + 1}`,
					},
					element: {
						type: "plain_text_input",
						action_id: `edit_proof_${index}`,
						initial_value: proofUrl,
					},
				});
			});
			proofsBlocks.push({ type: "divider" });
		}

		// Create modal blocks
		let blocks = [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Modification du paiement pour ${entityId}*\n*Problème signalé:* ${getProblemTypeText(
						problemType
					)}\n*Description du problème:*\n${
						problemDescription || "Non spécifié"
					}`,
				},
			},
			{ type: "divider" },
			{
				type: "input",
				block_id: "payment_title",
				element: {
					type: "plain_text_input",
					action_id: "input_payment_title",
					initial_value: paymentData.paymentTitle || paymentData.title || "",
				},
				label: {
					type: "plain_text",
					text: "Titre du paiement",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "payment_mode",
				element: {
					type: "static_select",
					action_id: "select_payment_mode",
					options: [
						{ text: { type: "plain_text", text: "Chèque" }, value: "Chèque" },
						{
							text: { type: "plain_text", text: "Virement" },
							value: "Virement",
						},
						{
							text: { type: "plain_text", text: "Mobile Money" },
							value: "Mobile Money",
						},
						{ text: { type: "plain_text", text: "Julaya" }, value: "Julaya" },
						{ text: { type: "plain_text", text: "Espèces" }, value: "Espèces" },
					],
					initial_option: {
						text: { type: "plain_text", text: paymentMode },
						value: paymentMode,
					},
				},
				label: {
					type: "plain_text",
					text: "Mode de paiement",
					emoji: true,
				},
			},
			{
				type: "actions",
				block_id: "confirm_payment_mode_2",
				elements: [
					{
						type: "button",
						action_id: "confirm_payment_mode_2",
						text: { type: "plain_text", text: "Ajouter les détails" },
						value: "confirm_payment_mode_2",
					},
				],
			},
			{
				type: "input",
				block_id: "amount_paid",
				element: {
					type: "number_input",
					action_id: "input_amount_paid",
					initial_value: (paymentData.amountPaid || 0).toString(),
					is_decimal_allowed: true,
					min_value: "0",
				},
				label: {
					type: "plain_text",
					text: "Montant payé",
					emoji: true,
				},
			},
			{
				type: "input",
				optional: true,
				block_id: "paiement_url",
				element: {
					type: "plain_text_input",
					action_id: "input_paiement_url",
					initial_value: paymentData.paymentUrl || "",
				},
				label: {
					type: "plain_text",
					text: "URL du paiement",
					emoji: true,
				},
			},
		];

		// Add existing proofs

		blocks = blocks.concat(proofsBlocks);

		// Add options for new proofs
		blocks.push(
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "Télécharger de nouveaux justificatifs ou ajouter de nouvelles URLs",
				},
			},
			{
				type: "input",
				block_id: "payment_proof_file",
				optional: true,

				label: {
					type: "plain_text",
					text: "📎 Nouveaux fichiers",
				},
				element: {
					type: "file_input",
					action_id: "file_upload_proof",

					filetypes: ["pdf", "jpg", "png"],
					max_files: 5,
				},
				hint: {
					type: "plain_text",
					text: "Si vous souhaitez conserver les fichiers existants, ne téléchargez pas de nouveaux fichiers.",
				},
			},
			{
				type: "input",
				block_id: "new_payment_url",
				optional: true,
				label: {
					type: "plain_text",
					text: "🔗 Nouvelle URL",
				},
				element: {
					type: "plain_text_input",
					action_id: "input_new_payment_url",
					placeholder: { type: "plain_text", text: "https://..." },
				},
				hint: {
					type: "plain_text",
					text: "Ajouter une nouvelle URL comme justificatif externe.",
				},
			}
		);

		// Add payment-mode-specific fields with prefill if the mode matches the original
		const isSameMode =
			paymentMode === (paymentData.paymentMode || paymentData.mode);
		if (paymentMode === "Chèque") {
			blocks.push(
				{
					type: "input",
					block_id: "cheque_number",
					element: {
						type: "plain_text_input",
						action_id: "input_cheque_number",
						initial_value: isSameMode ? details.cheque_number || "" : "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de chèque",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "cheque_bank",
					element: {
						type: "static_select",
						action_id: "input_cheque_bank",

						options: bankOptions,
						initial_option: isSameMode
							? getBankInitialOption(details.cheque_bank) || bankOptions[0]
							: bankOptions[0],
					},
					label: {
						type: "plain_text",
						text: "Banque",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "cheque_date",
					label: {
						type: "plain_text",
						text: "Date du chèque",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_cheque_date",

						initial_date:
							isSameMode && details.cheque_date
								? new Date(details.cheque_date).toISOString().split("T")[0]
								: undefined,
					},
				},
				{
					type: "input",
					block_id: "cheque_order",
					label: { type: "plain_text", text: "Ordre" },
					element: {
						type: "plain_text_input",
						action_id: "input_cheque_order",
						initial_value: isSameMode ? details.cheque_order || "" : "",
					},
				}
			);
		} else if (paymentMode === "Virement") {
			blocks.push(
				{
					type: "input",
					block_id: "virement_number",
					element: {
						type: "plain_text_input",
						action_id: "input_virement_number",
						initial_value: isSameMode ? details.virement_number || "" : "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de virement",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "virement_bank",
					element: {
						type: "static_select",
						action_id: "input_virement_bank",
						options: bankOptions,
						initial_option: isSameMode
							? getBankInitialOption(details.virement_bank) || bankOptions[0]
							: bankOptions[0],
					},
					label: {
						type: "plain_text",
						text: "Banque",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "virement_date",
					label: {
						type: "plain_text",
						text: "Date du virement",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_virement_date",

						initial_date:
							isSameMode && details.virement_date
								? new Date(details.virement_date).toISOString().split("T")[0]
								: undefined,
					},
				},
				{
					type: "input",
					block_id: "virement_order",
					label: { type: "plain_text", text: "Ordre" },
					element: {
						type: "plain_text_input",
						action_id: "input_virement_order",
						initial_value: isSameMode ? details.virement_order || "" : "",
					},
				}
			);
		} else if (paymentMode === "Mobile Money") {
			blocks.push(
				{
					type: "input",
					block_id: "mobilemoney_recipient_phone",
					element: {
						type: "plain_text_input",
						action_id: "input_mobilemoney_recipient_phone",
						initial_value: isSameMode
							? details.mobilemoney_recipient_phone || ""
							: "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de téléphone bénéficiaire",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_sender_phone",
					element: {
						type: "plain_text_input",
						action_id: "input_mobilemoney_sender_phone",
						initial_value: isSameMode
							? details.mobilemoney_sender_phone || ""
							: "",
					},
					label: {
						type: "plain_text",
						text: "Numéro envoyeur",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_date",
					label: {
						type: "plain_text",
						text: "Date",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_mobilemoney_date",

						initial_date:
							isSameMode && details.mobilemoney_date
								? new Date(details.mobilemoney_date).toISOString().split("T")[0]
								: undefined,
					},
				}
			);
		} else if (paymentMode === "Julaya") {
			blocks.push(
				{
					type: "input",
					block_id: "julaya_recipient",
					element: {
						type: "plain_text_input",
						action_id: "input_julaya_recipient",
						initial_value: isSameMode ? details.julaya_recipient || "" : "",
					},
					label: {
						type: "plain_text",
						text: "Bénéficiaire",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "julaya_transaction_number",
					element: {
						type: "plain_text_input",
						action_id: "input_julaya_transaction_number",
						initial_value: isSameMode
							? details.julaya_transaction_number || ""
							: "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de transaction",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "julaya_date",
					label: {
						type: "plain_text",
						text: "Date",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_julaya_date",

						initial_date:
							isSameMode && details.julaya_date
								? new Date(details.julaya_date).toISOString().split("T")[0]
								: undefined,
					},
				}
			);
		}

		console.log("paymentData", paymentData);
		console.log("paymentData.paymentProofs", paymentData.paymentProofs);
		console.log("paymentData.paymentUrl", paymentData.paymentUrl);

		const view = {
			type: "modal",
			callback_id: "payment_modification_submission",
			private_metadata: JSON.stringify({
				entityId,
				paymentIndex,
				reporterId,
				channelId: payload.channel?.id || process.env.SLACK_ADMIN_ID,
				existingProofs: paymentData.paymentProofs || [],
				existingUrls: paymentData.paymentUrl ? [paymentData.paymentUrl] : [],
				problemType,
				problemDescription,
			}),
			title: {
				type: "plain_text",
				text: "Modifier le paiement",
				emoji: true,
			},
			submit: {
				type: "plain_text",
				text: "Enregistrer",
				emoji: true,
			},
			close: {
				type: "plain_text",
				text: "Annuler",
				emoji: true,
			},
			blocks,
		};

		let response;
		if (payload.view?.id && selectedPaymentMode) {
			// Update existing modal
			console.log("Updating modal with view_id:", payload.view.id);
			response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.update",
				{
					view_id: payload.view.id,
					hash: payload.view.hash, // Include hash to prevent conflicts
					view,
				},
				process.env.SLACK_BOT_TOKEN,
				{ headers: { "Content-Type": "application/json; charset=utf-8" } }
			);
		} else {
			// Open new modal
			console.log("Opening new modal with trigger_id:", payload.trigger_id);
			response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.open",
				{ trigger_id: payload.trigger_id, view },
				process.env.SLACK_BOT_TOKEN,
				{ headers: { "Content-Type": "application/json; charset=utf-8" } }
			);
		}

		if (!response.data.ok) {
			throw new Error(`Slack API error: ${response.data.error}`);
		}

		context.log(`Payment modification modal opened for ${entityId}`);
		return {
			statusCode: 200,
			headers: { "Content-Type": "application/json" },
			body: "",
		};
		// return { response_action: "update" };
	} catch (error) {
		context.log(`Error handling modify payment: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				_error: `Une erreur s'est produite: ${error.message}`,
			},
		};
	}
}
async function handleReportProblemWithNotification(payload, context) {
	// Send immediate notification
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Process in background
	setImmediate(async () => {
		try {
			await handleReportProblem(payload, context);
		} catch (error) {
			context.log(
				`Error in report_problem background processing: ${error.message}`
			);
		}
	});

	return createSlackResponse(200, "");
}

// Handler for the "report_problem" button click
async function handleReportProblem(payload, context, messageTs) {
	console.log("** handleReportProblem");
	const entityId = payload.actions[0].value;
	const actionId = payload.actions[0].action_id;
	console.log("payload", payload);
	// Determine the callback_id based on which action triggered this handler
	const callback_id =
		actionId === "report_fund_problem"
			? "fund_problem_submission"
			: "payment_problem_submission";

	try {
		let entity;
		let request;
		if (callback_id == "payment_problem_submission") {
			// Fetch entity data (order or payment request)
			entity = await fetchEntity(entityId, context);
			if (!entity) {
				context.log(`Entity ${entityId} not found`);
				return {
					response_action: "errors",
					errors: {
						_error: `Entity ${entityId} not found`,
					},
				};
			}
		} else if (callback_id == "fund_problem_submission") {
			entity = await Caisse.findOne({
				"fundingRequests.requestId": entityId,
			});
			request = entity.fundingRequests.find((r) => r.requestId === entityId);
			if (request.status === "Validé") {
				context.log(`Funding blocked for request ${entityId}`);
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: process.env.SLACK_FINANCE_CHANNEL_ID,
						user: payload.user.id,
						text: `🚫 La demande a été finalisée`,
					},
					process.env.SLACK_BOT_TOKEN,
					context
				);
				return {};
			}
		}

		if (
			callback_id == "payment_problem_submission" &&
			entity.paymentDone == "true"
		) {
			context.log(`Payment blocked for order ${entityId}`);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: process.env.SLACK_FINANCE_CHANNEL_ID,
					user: payload.user.id,
					text: `🚫 La commande a été payée`,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			);
			return {};
		} else {
			// // Get the last payment
			// const lastPayment = entity.payments[entity.payments.length - 1];

			// Open a modal for problem reporting
			// Open confirmation modal
			const view = {
				type: "modal",
				callback_id: callback_id,
				private_metadata: JSON.stringify({
					entityId: entityId,

					paymentIndex:
						callback_id === "payment_problem_submission"
							? entity.payments.length - 1
							: undefined,
					channelId: payload.channel.id,
					userId: payload.user.username,
					messageTs: messageTs,
				}),
				title: {
					type: "plain_text",
					text: "Signaler un problème",
					emoji: true,
				},
				submit: {
					type: "plain_text",
					text: "Envoyer",
					emoji: true,
				},
				close: {
					type: "plain_text",
					text: "Annuler",
					emoji: true,
				},
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*Signalement d'un problème pour ${entityId}*`,
						},
					},
					{
						type: "divider",
					},
					{
						type: "input",
						block_id: "problem_type",
						element: {
							type: "static_select",
							action_id: "select_problem_type",

							options:
								callback_id === "fund_problem_submission"
									? [
											{
												text: {
													type: "plain_text",
													text: "Mode de paiement incorrect",
												},
												value: "wrong_payment_mode",
											},
											{
												text: {
													type: "plain_text",
													text: "Justificatif manquant ou incorrect",
												},
												value: "wrong_proof",
											},
											{
												text: {
													type: "plain_text",
													text: "Détails bancaires incorrects",
												},
												value: "wrong_bank_details",
											},
											{
												text: {
													type: "plain_text",
													text: "Autre problème",
												},
												value: "other",
											},
									  ]
									: [
											{
												text: {
													type: "plain_text",
													text: "Montant incorrect",
												},
												value: "wrong_amount",
											},
											{
												text: {
													type: "plain_text",
													text: "Mode de paiement incorrect",
												},
												value: "wrong_payment_mode",
											},
											{
												text: {
													type: "plain_text",
													text: "Justificatif manquant ou incorrect",
												},
												value: "wrong_proof",
											},
											{
												text: {
													type: "plain_text",
													text: "Détails bancaires incorrects",
												},
												value: "wrong_bank_details",
											},
											{
												text: {
													type: "plain_text",
													text: "Autre problème",
												},
												value: "other",
											},
									  ],
						},
						label: {
							type: "plain_text",
							text: "Type de problème",
							emoji: true,
						},
					},
					{
						type: "input",
						block_id: "problem_description",
						element: {
							type: "plain_text_input",
							action_id: "input_problem_description",
							multiline: true,
						},
						label: {
							type: "plain_text",
							text: "Description du problème",
							emoji: true,
						},
					},
				],
			};

			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.open",
				{ trigger_id: payload.trigger_id, view },
				process.env.SLACK_BOT_TOKEN
			);
			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
			context.log(`Problem report modal opened for ${entityId}`);
			return { response_action: "update" };
		}
	} catch (error) {
		context.log(`Error handling report problem: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				_error: `Une erreur s'est produite: ${error.message}`,
			},
		};
	}
}

async function RejectPayment(payload, context) {
	const paymentId = payload.actions[0].value;
	console.log("** RejectPayment", paymentId);
	// Open rejection modal (similar to orderStatusService.js)
	const view = {
		type: "modal",
		callback_id: "reject_payment_reason",
		title: { type: "plain_text", text: "Raison du rejet" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "input",
				block_id: "rejection_reason",
				element: {
					type: "plain_text_input",
					action_id: "input_reason",
					multiline: true,
				},
				label: { type: "plain_text", text: "Raison du rejet" },
			},
		],
		private_metadata: JSON.stringify({ paymentId }),
	};
	const response = await postSlackMessageWithRetry(
		"https://slack.com/api/views.open",
		{ trigger_id: payload.trigger_id, view },
		process.env.SLACK_BOT_TOKEN
	);
	context.log(`Rejection modal response: ${JSON.stringify(response)}`);
	return { statusCode: 200, body: "" };
}
// Handler for the payment problem submission
async function handlePaymentProblemSubmission(payload, context) {
	try {
		console.log("** handlePaymentProblemSubmission");
		const formData = payload.view.state.values;
		const metadata = JSON.parse(payload.view.private_metadata);
		const entityId = metadata.entityId;
		const paymentIndex = metadata.paymentIndex;

		// Extract problem details
		const problemType =
			formData.problem_type.select_problem_type.selected_option.value;
		const problemDescription =
			formData.problem_description.input_problem_description.value;

		// Fetch the entity
		const entity = await fetchEntity(entityId, context);
		if (!entity) {
			throw new Error(`Entity ${entityId} not found`);
		}
		console.log("entity111", entity);

		if (entityId.startsWith("CMD/")) {
			const updateResult = await Order.updateOne(
				{ id_commande: entityId },
				{
					$set: {
						blockPayment: true,
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);

			if (updateResult.modifiedCount === 0) {
				throw new Error(
					`Failed to update entity ${entityId} - no documents modified`
				);
			}
		} else if (entityId.startsWith("PAY/")) {
			await PaymentRequest.findOneAndUpdate(
				{ id_paiement: entityId },
				{
					$set: {
						blockPayment: true,
					},
				}
			);
		}
		// Get payment data

		const paymentData = entity.payments[paymentIndex];

		// Create blocks for admin notification
		const blocks = [
			{
				type: "header",
				text: {
					type: "plain_text",
					text: `⚠️ Problème de paiement signalé: ${entityId}`,
					emoji: true,
				},
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*ID:*\n${entityId}`,
					},
					{
						type: "mrkdwn",
						text: `*Signalé par:*\n<@${payload.user.id}>`,
					},
				],
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Type de problème:*\n${getProblemTypeText(problemType)}`,
					},
					{
						type: "mrkdwn",
						text: `*Date du signalement:*\n${new Date().toLocaleString(
							"fr-FR",
							{
								weekday: "long",
								year: "numeric",
								month: "long",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
								timeZoneName: "short",
							}
						)}
			`,
					},
				],
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Description du problème:*\n${problemDescription}`,
				},
			},
			{
				type: "divider",
			},
		];

		// Add payment details to blocks
		const paymentBlocks = await getPaymentBlocks(
			entity,
			{
				title: paymentData.paymentTitle || paymentData.title,
				mode: paymentData.paymentMode || paymentData.mode,
				amountPaid: paymentData.amountPaid,
				date: paymentData.dateSubmitted || paymentData.date,
				url: paymentData.paymentUrl || paymentData.url,
				proofs: paymentData.paymentProofs || paymentData.proofs || [],

				details: paymentData.details,
			},

			entity.remainingAmount,

			entity.paymentStatus || entity.statut
		);

		// Add all payment details except header (which is blocks[0])
		blocks.push(...paymentBlocks.slice(1));

		// Add modify payment button for admin
		blocks.push({
			type: "actions",

			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Modifier paiement",
						emoji: true,
					},
					style: "primary",
					action_id: "modify_payment",
					value: JSON.stringify({
						entityId: entityId,
						paymentIndex: paymentIndex,
						problemType: problemType,
						problemDescription: problemDescription,
						reporterId: payload.user.id,
					}),
				},
			],
		});

		// Send notification to admin channel
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `⚠️ Problème de paiement signalé pour ${entityId}`,
				blocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		// Also notify the finance channel that the problem has been reported
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				text: `✅ Le problème de paiement pour ${entityId} a été signalé aux administrateurs`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		return { response_action: "clear" };
	} catch (error) {
		context.log(`Error handling payment problem submission: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				problem_description: `Une erreur s'est produite: ${error.message}`,
			},
		};
	}
}
async function PaymentRejection(payload, action, context) {
	console.log("** PaymentRejection", payload, action);
	console.log("payload1", payload);
	const actionId = action.action_id;

	try {
		const isAccept = actionId === "payment_verif_accept";
		const paymentId = action.value;
		console.log("paymentId1", paymentId);
		let order;
		if (paymentId.startsWith("CMD/")) {
			order = await Order.findOne({ id_commande: paymentId });

			if (!order) {
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "Order not found.",
				});
			}
			// Check order status
			const status = order.statut;
			console.log("status1", status);
			// Check if the order has already been approved once
			if (order.isApprovedOnce) {
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: process.env.SLACK_ADMIN_ID,
						user: payload.user.id,
						text: `❌ Cet demande a déjà été ${status}e`,
					},
					process.env.SLACK_BOT_TOKEN
				);
				return { response_action: "clear" };
			}
		}
		if (paymentId.startsWith("PAY/")) {
			order = await PaymentRequest.findOne({ id_paiement: paymentId });
			// Check order status
			const status = order.statut;
			console.log("status1", status);
			if (!order) {
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "Order not found.",
				});
			}

			// Check if the order has already been approved once
			if (order.isApprovedOnce) {
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: process.env.SLACK_ADMIN_ID,
						user: payload.user.id,
						text: `❌ Cet demande a déjà été ${status}e`,
					},
					process.env.SLACK_BOT_TOKEN
				);
				return { response_action: "clear" };
			}
		}
		// Open confirmation modal
		const view = {
			type: "modal",
			callback_id: "payment_verif_confirm",
			title: { type: "plain_text", text: "Confirmation" },
			submit: { type: "plain_text", text: "Confirmer" },
			close: { type: "plain_text", text: "Annuler" },
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Êtes-vous sûr de vouloir ${
							isAccept ? "approuver" : "rejeter"
						} cette demande ?`,
					},
				},
			],
			private_metadata: JSON.stringify({
				paymentId,
				action: isAccept ? "accept" : "reject",
				message_ts: payload.message.ts,
			}),
		};

		await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		return { statusCode: 200, body: "" };
	} catch (error) {
		context.log(`Confirmation error: ${error}`);
		return createSlackResponse(500, "❌ Erreur de confirmation");
	}
}
module.exports = {
	handleModifyPayment,
	handleReportProblemWithNotification,
	handleReportProblem,
	handlePaymentProblemSubmission,
	RejectPayment,
	PaymentRejection,
};
