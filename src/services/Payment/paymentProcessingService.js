const Caisse = require("../../database/dbModels/Caisse");
const Order = require("../../database/dbModels/Order");
const PaymentRequest = require("../../database/dbModels/PaymentRequest");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const axios = require("axios");
const { syncCaisseToExcel } = require("../caisse/excelSyncService");
const { fetchEntity } = require("../../database/databaseUtils");
const { generatePaymentForm } = require("./paymentFormService");
const { bankOptions } = require("../../Handlers/Utils");
const { getPaymentBlocks } = require("../Order/blockBuilders");

async function handlePayment(orderId, paymentAmount, totalAmountDue, context) {
	console.log("** handlePayment");
	console.log("Input parameters:", { orderId, paymentAmount, totalAmountDue });

	let document;
	if (orderId.startsWith("PAY/")) {
		document = await PaymentRequest.findOne({ id_paiement: orderId });
		// FIXED: Get the amount paid BEFORE the current payment was added
		// We need to subtract the current payment to get the previous state
		const currentTotalAmountPaid = document.amountPaid || 0;
		const previousAmountPaid = currentTotalAmountPaid - paymentAmount; // This is the key fix!
		const remainingAmount = totalAmountDue - previousAmountPaid;

		console.log("Payment validation:", {
			currentTotalAmountPaid,
			previousAmountPaid,
			totalAmountDue,
			remainingAmount,
			newPaymentAmount: paymentAmount,
			willExceed: paymentAmount > remainingAmount,
		});

		if (paymentAmount > remainingAmount) {
			console.log("❌ Payment exceeds remaining amount:", {
				paymentAmount,
				remainingAmount,
				difference: paymentAmount - remainingAmount,
			});

			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_FINANCE_CHANNEL_ID,
					text: `❌ Le montant payé (${paymentAmount}) dépasse le montant restant dû (${remainingAmount}).`,
				},
				process.env.SLACK_BOT_TOKEN
			);

			throw new Error(
				`Le montant payé (${paymentAmount}) dépasse le montant restant dû (${remainingAmount}).`
			);
		}

		const newAmountPaid = currentTotalAmountPaid; // This is already correct
		const paymentStatus = determinePaymentStatus(totalAmountDue, newAmountPaid);
		const newremainingAmount = totalAmountDue - newAmountPaid;

		console.log("Payment calculation results:", {
			newAmountPaid,
			paymentStatus,
			newremainingAmount,
		});

		if (newremainingAmount == 0) {
			const updateResult = await PaymentRequest.updateOne(
				{ id_paiement: orderId }, // Fixed: was using id_commande instead of id_paiement
				{
					$set: {
						paymentDone: "true",
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);

			if (updateResult.modifiedCount === 0) {
				throw new Error(
					`Failed to update entity ${orderId} - no documents modified`
				);
			}
		} else {
			const updateResult = await PaymentRequest.updateOne(
				{ id_paiement: orderId },
				{
					$set: {
						paymentDone: "false",
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);
		}
		return {
			newAmountPaid,
			paymentStatus,
			totalAmountDue,
			remainingAmount: newremainingAmount,
		};
	} else {
		document = await Order.findOne({ id_commande: orderId });

		const amountPaid = document.amountPaid;
		console.log("amountPaid", amountPaid);
		const remainingAmount = totalAmountDue - amountPaid;
		console.log("totalAmountDue", totalAmountDue);
		console.log("remainingAmount000", remainingAmount);
		console.log("paymentAmount", paymentAmount);
		if (paymentAmount > remainingAmount) {
			// Post Slack message to the designated channel
			const slackResponse = await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_FINANCE_CHANNEL_ID,
					text: "❌ Le montant payé dépasse le montant restant dû.",
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!slackResponse.ok) {
				context.log(`${slackResponse.error}`);
			}
			throw new Error("Le montant payé dépasse le montant restant dû.");
		}
		let newAmountPaid;

		newAmountPaid = amountPaid + paymentAmount;

		console.log("newAmountPaid", newAmountPaid);
		const paymentStatus = determinePaymentStatus(totalAmountDue, newAmountPaid);
		console.log("paymentStatus", paymentStatus);
		const newremainingAmount = totalAmountDue - newAmountPaid;
		console.log("newremainingAmount", newremainingAmount);
		let updatedEntity;

		if (newremainingAmount == 0) {
			const updateResult = await Order.updateOne(
				{ id_paiement: orderId },
				{
					$set: {
						paymentDone: "true",
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);
			// Refresh entity to ensure latest data
			updatedEntity = await fetchEntity(orderId, context);
			console.log("1Updated entity:", updatedEntity);
			if (updateResult.modifiedCount === 0) {
				throw new Error(
					`Failed to update entity ${orderId} - no documents modified`
				);
			}
		} else {
			const updateResult = await Order.updateOne(
				{ id_commande: orderId },
				{
					$set: {
						paymentDone: "false",
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);
			// Refresh entity to ensure latest data
			updatedEntity = await fetchEntity(orderId, context);
			console.log("2Updated entity:", updatedEntity);
		}

		return {
			newAmountPaid,
			paymentStatus,
			totalAmountDue,
			remainingAmount: newremainingAmount,
		};
	}
}
async function calculateTotalAmountDue(orderId, context) {
	console.log("** calculateTotalAmountDue");
	// Check if this is a payment request or an order
	if (orderId.startsWith("PAY/")) {
		// This is a payment request
		const paymentRequest = await PaymentRequest.findOne({
			id_paiement: orderId,
		});
		if (!paymentRequest) {
			context.log(`Payment request not found: ${orderId}`);
			throw new Error("Commande non trouvée.");
		}
		// For payment requests, the total amount is simply the montant field
		return paymentRequest.montant;
	} else {
		// This is a regular order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			context.log(`Order not found: ${orderId}`);
			throw new Error("Commande non trouvée.");
		}
		// Calculate total from proformas for orders
		const validatedProforma = order.proformas.find((p) => p.validated);
		const totalAmountDue = validatedProforma.montant || 0;
		context.log(`Calculated totalAmountDue: ${totalAmountDue}`);
		return totalAmountDue;
	}
}
function determinePaymentStatus(totalAmountDue, amountPaid) {
	console.log("** determinePaymentStatus");
	if (totalAmountDue < 0 || amountPaid < 0) {
		throw new Error(
			"Invalid amounts: totalAmountDue or amountPaid cannot be negative"
		);
	}
	if (amountPaid === 0) return "En attente";
	if (amountPaid < totalAmountDue) return "Paiement Partiel";
	return "Payé";
}
async function handlePaymentModificationSubmission(payload, context) {
	console.log("** handlePaymentModificationSubmission");

	// Slack API configuration
	const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
	const SLACK_API_URL = "https://slack.com/api";

	// Helper function to post Slack messages
	async function postSlackMessageWithRetry(channel, text, blocks) {
		try {
			const response = await axios.post(
				`${SLACK_API_URL}/chat.postMessage`,
				{
					channel,
					text,
					blocks,
				},
				{
					headers: {
						Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
						"Content-Type": "application/json",
					},
				}
			);
			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
			console.log(`Slack message posted to channel ${channel}`);
		} catch (error) {
			console.error(`Error posting Slack message: ${error.message}`);
			throw error;
		}
	}

	// Helper function to post ephemeral Slack messages
	async function postSlackEphemeral(channel, user, text) {
		try {
			const response = await axios.post(
				`${SLACK_API_URL}/chat.postEphemeral`,
				{
					channel,
					user,
					text,
				},
				{
					headers: {
						Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
						"Content-Type": "application/json",
					},
				}
			);
			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
			console.log(
				`Ephemeral Slack message posted to user ${user} in channel ${channel}`
			);
		} catch (error) {
			console.error(`Error posting ephemeral Slack message: ${error.message}`);
			throw error;
		}
	}

	try {
		console.log("Handling payment modification submission");
		const metadata = JSON.parse(payload.view.private_metadata);
		console.log("Metadata$:", metadata);
		// Extract metadata and submitted values
		const privateMetadata = JSON.parse(payload.view.private_metadata);
		const entityId = metadata.entityId;
		const orderId = metadata.entityId;
		const paymentIndex = metadata.paymentIndex;
		console.log("$$ paymentIndex", paymentIndex);

		console.log("$$ existingProofs", metadata.existingProofs);
		console.log("$$ existingUrls", metadata.existingUrls);

		const values = payload.view.state.values;

		console.log("Submitted payload values:", JSON.stringify(values, null, 2));
		// console.log("Order ID:", orderId, "Payment Index:", paymentIndex);

		// Extract form data from the modal
		const paymentTitle = values.payment_title?.input_payment_title?.value || "";
		const paymentAmount =
			parseFloat(values.amount_paid?.input_amount_paid?.value) || 0;
		const paymentMode =
			values.payment_mode?.select_payment_mode?.selected_option?.value || "";
		let paymentUrl = values.paiement_url?.input_paiement_url?.value || "";
		const paymentDate = new Date();
		let paymentStatus = paymentAmount > 0 ? "Partiel" : "Non payé";
		paymentStatus = paymentAmount == 0 ? "Payé" : paymentStatus;

		console.log("$$ paymentStatus", paymentStatus);

		console.log("Extracted payment data:", {
			paymentTitle,
			paymentAmount,
			paymentMode,
			paymentUrl,
			paymentDate,
			paymentStatus,
		});

		// Prepare payment details based on mode
		let paymentDetails = {};
		if (paymentMode === "Chèque") {
			paymentDetails = {
				cheque_number: values.cheque_number?.input_cheque_number?.value || "",
				cheque_bank:
					values.cheque_bank?.input_cheque_bank?.selected_option?.value || "",
				cheque_date: values.cheque_date?.input_cheque_date?.selected_date || "",
				cheque_order: values.cheque_order?.input_cheque_order?.value || "",
			};
		} else if (paymentMode === "Virement") {
			paymentDetails = {
				virement_number:
					values.virement_number?.input_virement_number?.value || "",
				virement_bank:
					values.virement_bank?.input_virement_bank?.selected_option?.value ||
					"",
				virement_date:
					values.virement_date?.input_virement_date?.selected_date || "",
				virement_order:
					values.virement_order?.input_virement_order?.value || "",
			};
		} else if (paymentMode === "Mobile Money") {
			paymentDetails = {
				mobilemoney_recipient_phone:
					values.mobilemoney_recipient_phone?.input_mobilemoney_recipient_phone
						?.value,
				mobilemoney_sender_phone:
					values.mobilemoney_sender_phone?.input_mobilemoney_sender_phone
						?.value,
				mobilemoney_date:
					values.mobilemoney_date?.input_mobilemoney_date?.selected_date,
			};
		} else if (paymentMode === "Julaya") {
			paymentDetails = {
				julaya_recipient:
					values.julaya_recipient?.input_julaya_recipient?.value,
				julaya_date: values.julaya_date?.input_julaya_date?.selected_date,
				julaya_transaction_number:
					values.julaya_transaction_number?.input_julaya_transaction_number
						?.value,
			};
		}
		// Find the entity and get the original payment
		let entity;
		let originalPayment;
		let currency = "USD";

		if (orderId.startsWith("CMD/")) {
			entity = await Order.findOne({ id_commande: orderId });
			if (!entity || !entity.payments) {
				throw new Error(`Commande ${orderId} non trouvée ou sans paiements`);
			}

			if (paymentIndex < 0 || paymentIndex >= entity.payments.length) {
				throw new Error(
					`Index de paiement ${paymentIndex} invalide pour la commande ${orderId}`
				);
			}

			originalPayment = entity.payments[paymentIndex];

			console.log("Original payment:", originalPayment);

			if (
				entity.proformas &&
				entity.proformas.length > 0 &&
				entity.proformas[0].validated === true
			) {
				currency = entity.proformas[0].devise;
			}
		} else if (orderId.startsWith("PAY/")) {
			entity = await PaymentRequest.findOne({ id_paiement: orderId });
			if (!entity || !entity.payments) {
				throw new Error(
					`Demande de paiement ${orderId} non trouvée ou sans paiements`
				);
			}

			if (paymentIndex < 0 || paymentIndex >= entity.payments.length) {
				throw new Error(
					`Index de paiement ${paymentIndex} invalide pour la demande ${orderId}`
				);
			}

			originalPayment = entity.payments[paymentIndex];
			console.log("Original payment:", originalPayment);

			if (entity.devise) {
				currency = entity.devise;
			}
		} else {
			throw new Error(`Format d'ID non reconnu: ${orderId}`);
		}

		// Check caisse balance for cash payments
		if (paymentMode.trim() === "Espèces") {
			const originalAmount =
				originalPayment && originalPayment.paymentMode === "Espèces"
					? originalPayment.amountPaid || 0
					: 0;
			const amountChange = paymentAmount - originalAmount;
			console.log("Caisse check:", {
				originalAmount,
				paymentAmount,
				amountChange,
			});

			if (amountChange !== 0) {
				const caisse = await Caisse.findOne({});
				if (!caisse) {
					throw new Error("Caisse document not found");
				}

				const currentBalance = caisse.balances[currency] || 0;
				const projectedBalance = currentBalance - amountChange;
				console.log("Caisse balance check:", {
					currentBalance,
					amountChange,
					projectedBalance,
				});

				if (projectedBalance < 0) {
					console.log(
						`❌ Error: Insufficient funds in Caisse for ${currency}. Current: ${currentBalance}, Required: ${amountChange}`
					);
					await postSlackMessageWithRetry(
						process.env.SLACK_FINANCE_CHANNEL_ID || "C08KS4UH5HU",
						`❌ MODIFICATION DE PAIEMENT BLOQUÉE : Solde insuffisant dans la caisse pour ${currency}. Solde actuel: ${currentBalance}, Montant supplémentaire nécessaire: ${amountChange}. Veuillez recharger la caisse avant de procéder.`,
						[]
					);
					await postSlackEphemeral(
						payload.channel?.id || "C08KS4UH5HU",
						payload.user.id,
						`❌ Modification de paiement en espèces refusée pour ${orderId} : Solde insuffisant dans la caisse pour ${currency}. L'équipe des finances a été notifiée.`
					);
					return {
						status: 200,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ response_action: "clear" }),
					};
				}

				// Update Caisse balance
				const caisseUpdate = {
					$inc: { [`balances.${currency}`]: -amountChange },
					$push: {
						transactions: {
							type: "payment_modification",
							amount: -amountChange,
							currency,
							orderId,
							details: `Modification du paiement pour ${paymentTitle} (Order: ${orderId})`,
							timestamp: new Date(),
							paymentMethod: "Espèces",
							paymentDetails,
						},
					},
				};

				console.log("Caisse update:", caisseUpdate);
				const updatedCaisse = await Caisse.findOneAndUpdate({}, caisseUpdate, {
					new: true,
				}).catch((err) => {
					console.error(`Error updating Caisse: ${err.message}`);
					throw new Error(`Failed to update Caisse: ${err.message}`);
				});
				console.log(
					`New caisse balance for ${currency}: ${updatedCaisse.balances[currency]}`
				);

				// Sync Caisse to Excel
				if (updatedCaisse.latestRequestId) {
					await syncCaisseToExcel(
						updatedCaisse,
						updatedCaisse.latestRequestId
					).catch((err) => {
						console.error(`Error syncing Caisse to Excel: ${err.message}`);
					});
					console.log(
						`Excel file updated for latest request ${updatedCaisse.latestRequestId} with new balance for ${currency}`
					);
				} else {
					console.log(
						"No latestRequestId found in Caisse, skipping Excel sync"
					);
				}

				// Notify finance team
				await postSlackMessageWithRetry(
					process.env.SLACK_FINANCE_CHANNEL_ID || "C08KS4UH5HU",
					`✅ Modification de paiement en espèces traitée pour ${orderId}. Changement: ${amountChange} ${currency}. Nouveau solde de la caisse: ${updatedCaisse.balances[currency]}.`,
					[]
				);
			} else {
				console.log("No Caisse update needed: amountChange is 0");
			}
		}
		// FIX: Handle payment proofs properly
		// FIXED: Handle payment proofs properly
		let paymentProofs = [];

		// Extract existing_proof_${index} values
		const existingProofsFromForm = [];
		if (metadata.existingProofs && Array.isArray(metadata.existingProofs)) {
			metadata.existingProofs.forEach((_, index) => {
				const proofValue =
					values[`existing_proof_${index}`]?.[`edit_proof_${index}`]?.value;
				if (proofValue && typeof proofValue === "string" && proofValue.trim()) {
					existingProofsFromForm.push(proofValue.trim());
				}
			});
		}
		console.log("$$ Existing Proofs from Form:", existingProofsFromForm);

		// Start with existing proofs from form (non-deleted)
		paymentProofs = [...existingProofsFromForm];

		// Add new URL as a proof if provided
		if (values.new_payment_url?.input_new_payment_url?.value) {
			const newUrl = values.new_payment_url.input_new_payment_url.value;
			if (!paymentProofs.includes(newUrl)) {
				paymentProofs.push(newUrl);
				console.log("$$ Added new payment URL as proof:", newUrl);
			}
		}
		console.log("$$ url", values.new_payment_url?.input_new_payment_url?.value);
		// Add file uploads if provided
		if (
			values.payment_proof_file?.file_upload_proof?.files &&
			values.payment_proof_file.file_upload_proof.files.length > 0
		) {
			const fileUrls = values.payment_proof_file.file_upload_proof.files
				.map((file) => file.permalink)
				.filter(
					(url) =>
						url && typeof url === "string" && !paymentProofs.includes(url)
				);

			paymentProofs = paymentProofs.concat(fileUrls);
			console.log("$$ Added file upload proofs:", fileUrls);
		}

		// Remove any undefined/null values and duplicates
		paymentProofs = [
			...new Set(
				paymentProofs.filter(
					(proof) => proof && typeof proof === "string" && proof.trim()
				)
			),
		];
		console.log("$$ Final Payment proofs:", paymentProofs);

		console.log("$$ Payment proof:", paymentProofs);

		// Prepare the updated payment object
		const updatedPayment = {
			paymentMode,
			amountPaid: paymentAmount,
			paymentTitle,
			paymentUrl,
			paymentProofs,
			details: paymentDetails,
			status: paymentStatus,
			dateSubmitted: paymentDate,
		};

		console.log("Updated payment data:", updatedPayment);

		// Update the payment in the database
		if (orderId.startsWith("CMD/")) {
			entity.payments[paymentIndex] = {
				...entity.payments[paymentIndex],
				...updatedPayment,
				_id: entity.payments[paymentIndex]._id,
			};

			// Update total amount paid and remaining amount
			const totalAmountPaid = entity.payments.reduce(
				(sum, payment) => sum + (payment.amountPaid || 0),
				0
			);
			const totalAmountDue = await calculateTotalAmountDue(entityId, context);
			entity.amountPaid = totalAmountPaid;
			entity.remainingAmount = totalAmountDue - totalAmountPaid;

			entity.paymentDone = entity.remainingAmount <= 0;
			console.log("entity.remainingAmount:", entity.remainingAmount);

			entity.payments.paymentStatus =
				entity.remainingAmount == 0 ? "Payé" : paymentStatus;

			paymentStatus = entity.payments.paymentStatus;
			console.log("$$ paymentStatus", paymentStatus);

			await entity.save();
			console.log(`Payment ${paymentIndex} updated in order ${orderId}`);
		} else if (orderId.startsWith("PAY/")) {
			entity.payments[paymentIndex] = {
				...entity.payments[paymentIndex],
				...updatedPayment,
				_id: entity.payments[paymentIndex]._id,
			};

			// Update total amount paid and remaining amount
			const totalAmountPaid = entity.payments.reduce(
				(sum, payment) => sum + (payment.amountPaid || 0),
				0
			);
			const totalAmountDue = await calculateTotalAmountDue(entityId, context);
			entity.amountPaid = totalAmountPaid;
			entity.remainingAmount = totalAmountDue - totalAmountPaid;

			entity.paymentDone = entity.remainingAmount <= 0;

			entity.payments.paymentStatus =
				entity.remainingAmount == 0 ? "Payé" : paymentStatus;

			console.log("$$ paymentStatus", paymentStatus);

			await entity.save();
			console.log(
				`Payment ${paymentIndex} updated in payment request ${orderId}`
			);
		}
		console.log("C");

		let updateResult;
		let updatedEntity;
		if (entityId.startsWith("CMD/")) {
			updateResult = await Order.updateOne(
				{ id_commande: entityId },
				{
					$set: {
						blockPayment: false,
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);
			// Refresh entity to ensure latest data
			updatedEntity = await fetchEntity(entityId, context);
			// console.log("Updated entity:", updatedEntity);
		} else if (entityId.startsWith("PAY/")) {
			updateResult = await PaymentRequest.findOneAndUpdate(
				{ id_paiement: entityId },
				{
					$set: {
						blockPayment: false,
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);
			// Refresh entity to ensure latest data
				// eslint-disable-next-line no-unused-vars
			updatedEntity = await fetchEntity(entityId, context);
			// console.log("Updated entity:", updatedEntity);
		}
		// Notify the user via Slack
		const channelId = privateMetadata.channelId || "C08KS4UH5HU";
		const userId = payload.user.id;
		const channels = [
			process.env.SLACK_FINANCE_CHANNEL_ID,
			entity.demandeurId, // Assuming this is a Slack user ID for DM
			channelId, // Original channel ID
		];
		console.log("°°° paymentUrl", paymentUrl);
		console.log("°°° paymentProofs", paymentProofs);
		console.log("Channels to notify:", channels);
		console.log("paymentDetails", paymentDetails);

		for (const Channel of channels) {
			const isFinanceChannel = Channel === process.env.SLACK_FINANCE_CHANNEL_ID;

			// Build the blocks array
			const blocks = [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `💲 🔄 Paiement Modifié: ${orderId}`,
						emoji: true,
					},
				},
			];

			// Add payment details to blocks
			console.log("à entity", entity);

			console.log("entity.paymentStatus", entity.paymentStatus);
			console.log("entity.statut", entity.statut);
			console.log("paymentUrl", paymentUrl);
			console.log("paymentProofs", paymentProofs);
			console.log("paymentDetails", paymentDetails);

			const paymentBlocks = await getPaymentBlocks(
				entity,
				{
					title: paymentTitle || "",
					mode: paymentMode || "",
					amountPaid: paymentAmount || "",
					date: paymentDate || "",
					url: paymentUrl || [],
					proofs: paymentProofs || [],

					details: paymentDetails,
				},
				entity.remainingAmount,
				paymentStatus || entity.statut
			);

			// Add all payment details except header (which is blocks[0])
			blocks.push(...paymentBlocks.slice(1));

			// Add action buttons for finance channel
			if (isFinanceChannel) {
				blocks.push({
					type: "actions",
					elements: [
						{
							type: "button",
							text: {
								type: "plain_text",
								text: "Enregistrer paiement",
								emoji: true,
							},
							style: "primary",
							action_id: "finance_payment_form",
							value: entityId,
						},
					],
				});
			}

			// Post the message
			await postSlackMessageWithRetry(
				Channel,
				`✅ Paiement modifié avec succès pour ${orderId}`,
				blocks
			);
		}
		console.log(`Notification sent to channel ${channelId} for user ${userId}`);

		// Return response to clear the modal
		return {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
	} catch (error) {
		console.error(`Error in handlePaymentModificationSubmission: ${error}`);

		try {
			await postSlackEphemeral(
				payload.channel?.id || "C08KS4UH5HU",
				payload.user.id,
				`❌ Erreur lors de la modification du paiement: ${error.message}`
			);
		} catch (slackError) {
			console.error(`Error sending error notification: ${slackError}`);
		}

		throw error;
	}
}
async function handleFinancePaymentForm(payload, action, context) {
	const entityId = action.value;
	context.log(`Processing finance_payment_form for entity: ${entityId}`);

	try {
		const entity = await fetchEntity(entityId, context);
		if (!entity) {
			throw new Error(`Entity ${entityId} not found`);
		}

		// Check various blocking conditions
		if (entity.blockPayment) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel.id,
					user: payload.user.id,
					text: `🚫 Le paiement pour ${entityId} est bloqué. Veuillez contacter un administrateur.`,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			);
			return createSlackResponse(200, "");
		}

		if (entity.paymentDone === "true" || entity.paymentDone === true) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel.id,
					user: payload.user.id,
					text: `🚫 La commande a été payée`,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			);
			return createSlackResponse(200, "");
		}

		if (entityId.startsWith("CMD/") && entity.deleted === true) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel.id,
					user: payload.user.id,
					text: `🚫 La commande a été supprimée`,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			);
			return createSlackResponse(200, "");
		}

		// Proceed with payment form generation
		context.log(`Opening payment form for order ${entityId}`);
		return await generatePaymentForm({
			payload,
			action,
			context,
			selectedPaymentMode: null,
			orderId: entityId,
		});
	} catch (error) {
		context.log(`Error in finance_payment_form: ${error.message}`);
		throw error;
	}
}
// Function to handle the block actions for payment method selection
async function handlePaymentMethodSelection(payload) {
	console.log("** handlePaymentMethodSelection");
	const selectedValue = payload.actions[0].selected_option?.value;
	console.log("Selected payment method:", selectedValue);

	if (!selectedValue) {
		console.error("No payment method selected in payload");
		return;
	}

	if (selectedValue !== "cheque") {
		console.log("Not cheque, no modal update needed");
		// Optionally, remove cheque fields if previously added
		const viewId = payload.view.id;
		let blocks = payload.view.blocks.filter(
			(block) =>
				![
					"cheque_number",
					"cheque_bank",
					"cheque_date",
					"cheque_order",
				].includes(block.block_id)
		);

		try {
			await postSlackMessageWithRetry(
				"https://slack.com/api/views.update",
				{
					view_id: viewId,
					view: {
						type: "modal",
						callback_id: "submit_finance_details",
						private_metadata: payload.view.private_metadata,
						title: { type: "plain_text", text: "Détails financiers" },
						submit: { type: "plain_text", text: "Soumettre" },
						close: { type: "plain_text", text: "Annuler" },
						blocks: blocks,
					},
				},
				process.env.SLACK_BOT_TOKEN
			);
			console.log("Modal updated to remove cheque fields");
		} catch (error) {
			console.error("Error removing cheque fields:", error);
		}
		return;
	}

	const viewId = payload.view.id;
	const requestId = payload.view.private_metadata;

	// Get current blocks and remove existing cheque fields to avoid duplicates
	let blocks = payload.view.blocks.filter(
		(block) =>
			!["cheque_number", "cheque_bank", "cheque_date", "cheque_order"].includes(
				block.block_id
			)
	);

	// Add cheque detail blocks
	blocks.push(
		{ type: "divider" },
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: "*Détails du chèque*",
			},
		},
		{
			type: "input",
			block_id: "cheque_number",
			element: {
				type: "number_input",
				action_id: "input_cheque_number",
				is_decimal_allowed: false,
				min_value: "0",
			},
			label: { type: "plain_text", text: "Numéro du Chèque" },
		},
		{
			type: "input",
			block_id: "cheque_bank",
			label: { type: "plain_text", text: "Banque" },
			element: {
				type: "static_select",
				action_id: "input_cheque_bank",
				options: bankOptions,
			},
		},
		{
			type: "input",
			block_id: "cheque_date",
			label: { type: "plain_text", text: "Date du chèque" },
			element: { type: "datepicker", action_id: "input_cheque_date" },
		},
		{
			type: "input",
			block_id: "cheque_order",
			label: { type: "plain_text", text: "Ordre" },
			element: { type: "plain_text_input", action_id: "input_cheque_order" },
		},
		// Add new file upload field
		{
			type: "input",
			block_id: "cheque_files",
			optional: true,
			element: {
				type: "file_input",
				action_id: "input_cheque_files",
				filetypes: ["pdf", "png", "jpg", "jpeg"],
				max_files: 3,
			},
			label: { type: "plain_text", text: "Fichiers" },
		},
		// Add URL input field for external links
		{
			type: "input",
			block_id: "cheque_urls",
			optional: true,
			element: {
				type: "plain_text_input",
				action_id: "input_cheque_urls",
				placeholder: {
					type: "plain_text",
					text: "URLs séparées par des virgules",
				},
			},
			// label: { type: "plain_text", text: "Liens vers les documents (séparés par des virgules)" },
			label: { type: "plain_text", text: "Lien " },
		}
	);

	// Update the modal
	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.update",
			{
				view_id: viewId,
				view: {
					type: "modal",
					callback_id: "submit_finance_details",
					private_metadata: requestId,
					title: { type: "plain_text", text: "Détails financiers" },
					submit: { type: "plain_text", text: "Soumettre" },
					close: { type: "plain_text", text: "Annuler" },
					blocks: blocks,
				},
			},
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Modal updated with cheque fields for request:", requestId);
	} catch (error) {
		console.error("Error updating modal with cheque fields:", error);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.user.id,
				user: payload.user.id,
				text: "❌ Erreur lors de la mise à jour du formulaire. Veuillez réessayer.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
}
module.exports = {
	handlePaymentModificationSubmission,
	handleFinancePaymentForm,
	handlePaymentMethodSelection,handlePayment
};
