const CommandSequence = require("../../database/dbModels/CommandSequence");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const { removeAccents } = require("./orderHelpers");
const Order = require("../../database/dbModels/Order");
createSlackResponse;

// Command ID Generation
async function generateCommandId() {
	console.log("** generateCommandId");
	try {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const yearMonth = `${year}-${month}`;

		const seq = await CommandSequence.findOneAndUpdate(
			{ yearMonth },
			{ $inc: { currentNumber: 1 } },
			{ new: true, upsert: true, returnDocument: "after" }
		);

		return `CMD/${year}/${month}/${String(seq.currentNumber).padStart(4, "0")}`;
	} catch (error) {
		console.error("Error generating command ID:", error);
		throw error;
	}
}
// Order Creation
async function createAndSaveOrder(
	id,
	userId,
	channelName,
	channelId,
	formData,
	articles,
	date,
	proformas
) {
	console.log("** createAndSaveOrder");
	try {
		console.log("channelName", channelName);
		console.log("channelId", channelId);
		console.log("formData", formData);
		console.log(
			"articles",
			formData.equipe_selection?.select_equipe?.selected_option?.text
		);
		// context.log("createAndSaveOrder function");
		// Get the selected date string from the form data
		let requestDate;
		// console.log("formData.request_date?.input_request_date?.selected_date",formData.request_date?.input_request_date?.selected_date);
		if (formData.request_date?.input_request_date?.selected_date) {
			// Get just the date part (YYYY-MM-DD) and create a date at 00:00:00 UTC
			const dateStr = formData.request_date.input_request_date.selected_date;
			// Create a date object and then format it back to YYYY-MM-DD to remove time portion
			requestDate = dateStr.split("T")[0];
			// console.log("requestDate11",requestDate);
		} else {
			// Use current date, formatted as YYYY-MM-DD
			requestDate = new Date().toISOString().split("T")[0];
			// console.log("requestDate22",requestDate);
		}

		// Extract the team value from the selected option
		let teamValue = "Non spécifié";
		if (formData.equipe_selection?.select_equipe?.selected_option?.text?.text) {
			teamValue =
				formData.equipe_selection.select_equipe.selected_option.text.text;
		} else if (formData.equipe) {
			teamValue = formData.equipe;
		} else if (typeof formData.equipe_selection === "string") {
			teamValue = formData.equipe_selection;
		}
		const orderData = {
			id_commande: await generateCommandId(),
			channel: channelName || channelId || "N/A",
			channelId: channelId || "N/A",
			titre: formData.request_title?.input_request_title?.value,
			demandeur: userId,
			demandeurId: id,
			articles: articles,
			equipe: teamValue,
			proformas: proformas,
			statut: "En attente",
			date: new Date(), // This is the creation date (with time)
			date_requete: requestDate, // This is just the date string YYYY-MM-DD
			autorisation_admin: false,
			payment: { status: "En attente" },
		};

		// context.log(`Order data before save: ${JSON.stringify(orderData)}`);

		const order = new Order(orderData);
		const savedOrder = await order.save();
		return savedOrder;
	} catch (error) {
		console.error("Error creating and saving order:", error);
		throw error;
	}
}
async function handleOrderListSlack(isAdmin, context) {
	console.log("** handleOrderListSlack");
	// Fetch the most recent 10 orders (adjust limit as needed)
	const orders = await Order.find({}).sort({ date: -1 }).limit(10);
	context.log(
		"Orders fetched for handleOrderListSlack:",
		JSON.stringify(orders)
	);

	if (!orders || orders.length === 0) {
		return createSlackResponse(200, {
			response_type: "in_channel",
			text: "Aucune commande trouvée.",
		});
	}

	// Build Block Kit response
	const blocks = [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: "📋 Liste des Commandes Récentes",
				emoji: true,
			},
		},
		{
			type: "divider",
		},
	];

	// Add each order as a section with fields
	orders.forEach((order) => {
		blocks.push({
			type: "section",

			fields: [
				{ type: "mrkdwn", text: `*ID:*\n#${order.id_commande}` },
				{ type: "mrkdwn", text: `*Titre:*\n${order.titre || "Sans titre"}` },
				{ type: "mrkdwn", text: `*Date:*\n${order.date}` },

				{ type: "mrkdwn", text: `*Demandeur:*\n<@${order.demandeur}>` },
				{
					type: "mrkdwn",

					text: `*Équipe:*\n${order.equipe.displayName || "N/A"}`,
				},
				{ type: "mrkdwn", text: `*Date:*\n${order.date.toLocaleDateString()}` },
				{ type: "mrkdwn", text: `*Statut:*\n${order.statut || "Non défini"}` },
				{ type: "mrkdwn", text: `*Total Payé:*\n${order.amountPaid || 0}€` },
				{ type: "mrkdwn", text: `*Articles:*\n${order.articles.length}` },
			],
		});

		// Optional: Add action buttons (e.g., view details)
		blocks.push({
			type: "actions",

			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Voir Détails",
						emoji: true,
					},
					value: `order_details_${order.id_commande}`,
					action_id: `view_order_${order.id_commande}`,
				},
			],
		});

		blocks.push({ type: "divider" });
	});

	return createSlackResponse(200, {
		response_type: "ephemeral", // Use "in_channel" if you want it visible to all
		blocks: blocks,
	});
}
// Order List Handling
async function handleOrderList(isAdmin, context) {
	console.log("** handleOrderList");
	if (!isAdmin) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "🚫 Vous n'êtes pas autorisé à voir la liste des commandes.",
		});
	}

	const orders = await Order.find({}).sort({ date: -1 }).limit(10);
	context.log("Orders fetched for handleOrderList:", JSON.stringify(orders));

	if (orders.length === 0) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "📭 Aucune commande trouvée.",
		});
	}

	let responseText = "*📋 Rapport des Dernières Commandes*\n\n";

	orders.forEach((order) => {
		context.log("Processing order:", JSON.stringify(order));

		responseText += `* Commande #${order.id_commande}*\n`;

		// Order Header Information
		const headerDetails = [
			`👤 *Demandeur:* <@${order.demandeur}>`,
			`📌 *Titre:* ${order.titre}`,
			`#️⃣ *Canal:* #${order.channel || "Non spécifié"}`,
			`👥 *Équipe:* ${order.equipe || "Non spécifié"}`,
			`📅 *Date:* ${order.date.toLocaleString()}`,
			`⚙️ *Statut:* ${order.statut || "Non défini"}`,
			`🔐 *Autorisation Admin:* ${
				order.autorisation_admin ? "✅ Autorisé" : "❌ Non autorisé"
			}`,
		];

		responseText += headerDetails.join("\n") + "\n";

		// Rejection Reason (if applicable)
		if (order.rejection_reason) {
			responseText += `🚫 *Raison du Rejet:* ${order.rejection_reason}\n`;
		}

		// Articles Details
		responseText += "\n*📦 Articles Commandés:*\n";
		if (order.articles.length > 0) {
			order.articles.forEach((article, i) => {
				responseText += `  ${i + 1}. ${article.quantity} ${article.unit} - ${
					article.designation
				}\n`;
			});
		} else {
			responseText += "  - Aucun article\n";
		}

		// Proformas
		responseText += "\n*📝 Proformas:*\n";
		if (order.proformas.length > 0) {
			order.proformas.forEach((proforma, i) => {
				responseText += `  ${i + 1}. `;
				responseText += `*Nom:* <${proforma.urls}|${
					proforma.nom || `Proforma ${i + 1}`
				}> `;
				responseText += `| *Montant:* ${proforma.montant} ${proforma.devise} `;
				responseText += `| *fichiers:* ${proforma.file_ids || "N/A"}\n`;
			});
		} else {
			responseText += "  - Aucun\n";
		}

		// Payments
		responseText += "\n*💰 Détails des Paiements:*\n";
		if (order.payments.length > 0) {
			order.payments.forEach((payment, i) => {
				responseText += `  *Paiement ${i + 1}:*\n`;
				responseText += `    • *Mode:* ${payment.paymentMode}\n`;
				responseText += `    • *Titre:* ${payment.paymentTitle}\n`;
				responseText += `    • *Montant:* ${payment.amountPaid}€\n`;
				responseText += `    • *Statut:* ${
					payment.paymentStatus || "Partiel"
				}\n`;
				responseText += `    • *Date:* ${payment.dateSubmitted.toLocaleString()}\n`;

				// Payment Proof
				if (payment.paymentProofs?.length > 0) {
					responseText += `    • *Preuve:* <${payment.paymentProofs}|Justificatif>\n`;
				} else if (payment.paymentUrl) {
					responseText += `    • *Lien:* <${payment.paymentUrl}|Lien de Paiement>\n`;
				} else {
					responseText += `    • *Preuve:* Aucune\n`;
				}

				// Payment Details
				responseText += "    • *Détails Supplémentaires:*\n";
				if (payment.details && Object.keys(payment.details).length > 0) {
					Object.entries(payment.details).forEach(([key, value]) => {
						responseText += `      - ${key}: ${value}\n`;
					});
				} else {
					responseText += "      - Aucun détail supplémentaire\n";
				}
			});
		} else {
			responseText += "  - Aucun paiement\n";
		}

		// Total Amount Paid
		responseText += `\n*Total Payé:* ${order.amountPaid || 0}€\n`;

		// Separator between orders
		responseText += "\n" + "=".repeat(40) + "\n\n";
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: responseText,
	});
}
async function handleOrderOverview(isAdmin, filters, context) {
	console.log("** handleOrderOverview");
	let orders = await Order.find({}).sort({ date: -1 }).limit(100);
	context.log(
		"Orders fetched for handleOrderOverview:",
		JSON.stringify(orders)
	);

	if (!orders || orders.length === 0) {
		return createSlackResponse(200, "Aucune commande trouvée.");
	}

	// Apply filters
	if (filters.titre) {
		orders = orders.filter((order) =>
			order.titre.toLowerCase().includes(filters.titre.toLowerCase())
		);
	}
	if (filters.statut) {
		const normalizedFilterStatus = removeAccents(filters.statut.toLowerCase());
		orders = orders.filter((order) => {
			const normalizedOrderStatus = removeAccents(
				(order.statut || "Non défini").toLowerCase()
			);
			const matches = normalizedOrderStatus === normalizedFilterStatus;
			context.log(
				`🔎 Comparing statut: ${normalizedOrderStatus} vs ${normalizedFilterStatus} -> ${matches}`
			);
			return matches;
		});
	}

	if (filters.date) {
		context.log(`Filtering by date: ${filters.date}`);
		const filterDate = new Date(filters.date);
		context.log(`Parsed filter date: ${filterDate.toLocaleDateString()}`);
		orders = orders.filter(
			(order) =>
				order.date.toLocaleDateString() === filterDate.toLocaleDateString()
		);
		console.log("orders", orders);
	}
	if (filters.demandeur) {
		orders = orders.filter(
			(order) =>
				order.demandeur.toLowerCase() === filters.demandeur.toLowerCase()
		);
	}
	if (filters.equipe) {
		orders = orders.filter((order) =>
			order.equipe.id.toLowerCase().includes(filters.equipe.toLowerCase())
		);
	}
	if (filters.autorisation_admin) {
		const authFilter = filters.autorisation_admin.toLowerCase() === "true";
		orders = orders.filter((order) => order.autorisation_admin === authFilter);
	}
	if (filters.paymentStatus) {
		const normalizedPaymentStatus = removeAccents(
			filters.paymentStatus.toLowerCase()
		);
		orders = orders.filter((order) =>
			order.payments.some(
				(payment) =>
					removeAccents((payment.paymentStatus || "").toLowerCase()) ===
					normalizedPaymentStatus
			)
		);
	}

	// // Generate overview response
	let responseText = "*Vue des Commandes filtré*\n\n";
	responseText +=
		"Filtres appliqués : " +
		(filters.titre ? `Titre: ${filters.titre}` : "Aucun titre") +
		", " +
		(filters.statut ? `Statut: ${filters.statut}` : "Aucun statut") +
		", " +
		(filters.date ? `Date: ${filters.date}` : "Aucune date") +
		", " +
		(filters.demandeur
			? `Demandeur: ${filters.demandeur}`
			: "Aucun demandeur") +
		", " +
		(filters.equipe ? `Équipe: ${filters.equipe}` : "Aucune équipe") +
		", " +
		(filters.autorisation_admin
			? `Autorisation Admin: ${filters.autorisation_admin}`
			: "Aucune autorisation") +
		", " +
		(filters.paymentStatus
			? `Statut Paiement: ${filters.paymentStatus}`
			: "Aucun statut paiement") +
		"\n\n";

	if (orders.length === 0) {
		responseText += "Aucune commande ne correspond aux filtres.";
	} else {
		// orders.forEach((order) => {
		//   const totalPaid = order.amountPaid || 0;
		//   responseText +=
		//     `📋 *${order.titre}* (Statut: ${order.statut || "Non défini"}) - <@${order.demandeur}>\n` +
		//     `   Équipe: ${order.equipe} | Date: ${order.date.toLocaleDateString()} | Total Payé: ${totalPaid}€ | Admin: ${order.autorisation_admin ? "✅" : "❌"}\n`;
		// });

		orders.forEach((order) => {
			context.log("Processing order:", JSON.stringify(order));

			responseText += `* Commande #${order.id_commande}*\n`;

			// Order Header Information
			const headerDetails = [
				`👤 *Demandeur:* <@${order.demandeur}>`,
				`📌 *Titre:* ${order.titre}`,
				`#️⃣ *Canal:* #${order.channel || "Non spécifié"}`,

				`👥 *Équipe:* ${order.equipe.displayName || "Non spécifié"}`,
				`📅 *Date:* ${order.date.toLocaleString()}`,
				`⚙️ *Statut:* ${order.statut || "Non défini"}`,
				`🔐 *Autorisation Admin:* ${
					order.autorisation_admin ? "✅ Autorisé" : "❌ Non autorisé"
				}`,
			];

			responseText += headerDetails.join("\n") + "\n";

			// Rejection Reason (if applicable)
			if (order.rejection_reason) {
				responseText += `🚫 *Raison du Rejet:* ${order.rejection_reason}\n`;
			}

			// Articles Details
			responseText += "\n*📦 Articles Commandés:*\n";
			if (order.articles.length > 0) {
				order.articles.forEach((article, i) => {
					responseText += `  ${i + 1}. ${article.quantity} ${article.unit} - ${
						article.designation
					}\n`;
				});
			} else {
				responseText += "  - Aucun article\n";
			}

			// Proformas
			responseText += "\n*📝 Proformas:*\n";
			if (order.proformas.length > 0) {
				order.proformas.forEach((proforma, i) => {
					responseText += `  ${i + 1}. `;
					responseText += `*Nom:* <${proforma.urls}|${
						proforma.nom || `Proforma ${i + 1}`
					}> `;
					responseText += `| *Montant:* ${proforma.montant} ${proforma.devise} `;
					responseText += `| *Fichiers:* ${proforma.file_ids || "N/A"}\n`;
				});
			} else {
				responseText += "  - Aucun\n";
			}

			// Payments
			responseText += "\n*💰 Détails des Paiements:*\n";
			if (order.payments.length > 0) {
				order.payments.forEach((payment, i) => {
					responseText += `  *Paiement ${i + 1}:*\n`;
					responseText += `    • *Mode:* ${payment.paymentMode}\n`;
					responseText += `    • *Titre:* ${payment.paymentTitle}\n`;
					responseText += `    • *Montant:* ${payment.amountPaid}€\n`;
					responseText += `    • *Statut:* ${payment.paymentStatus || "N/A"}\n`;
					responseText += `    • *Date:* ${payment.dateSubmitted.toLocaleString()}\n`;

					// Payment Proof
					if (payment.paymentProofs?.length > 0) {
						responseText += `    • *Preuve:* <${payment.paymentProofs}|Justificatif>\n`;
					} else if (payment.paymentUrl) {
						responseText += `    • *Lien:* <${payment.paymentUrl}|Lien de Paiement>\n`;
					} else {
						responseText += `    • *Preuve:* Aucune\n`;
					}

					// Payment Details
					responseText += "    • *Détails Supplémentaires:*\n";
					if (payment.details && Object.keys(payment.details).length > 0) {
						Object.entries(payment.details).forEach(([key, value]) => {
							responseText += `      - ${key}: ${value}\n`;
						});
					} else {
						responseText += "      - Aucun détail supplémentaire\n";
					}
				});
			} else {
				responseText += "  - Aucun paiement\n";
			}

			// Total Amount Paid
			responseText += `\n*Total Payé:* ${order.amountPaid || 0}€\n`;

			// Separator between orders
			responseText += "\n" + "=".repeat(40) + "\n\n";
		});
	}

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: responseText,
	});
}
// Function to perform the actual deletion after confirmation
async function executeOrderDeletion(payload, metadata, reason, context) {
	console.log("** executeOrderDeletion");
	try {
		context.log("Executing order deletion");
		let orderId;
		let order;
		// Parse metadata if it's a string
		const data = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
		const { messageTs, channelId } = data;
		if (messageTs) {
			order = await Order.findOne({
				"slackMessages.ts": messageTs,
				"slackMessages.channel": channelId,
			});
			console.log("$$ order", order);
			// If not found, try by the proforma validation info from the message
			if (!order) {
				// Get the user ID from the message text
				const validatorId = payload.user
					? payload.user.id
					: payload.user_id || "unknown";

				// Find orders with validated proformas by this user
				const orders = await Order.find({
					"proformas.validated": true,
					"proformas.validatedBy": validatorId,
				}).sort({ "proformas.validatedAt": -1 });

				if (orders.length > 0) {
					order = orders[0];
				}
			}

			if (!order) {
				throw new Error("Impossible de trouver la commande associée");
			}

			orderId = order.id_commande;
		} else {
			order = await Order.findOne({
				id_commande: metadata.orderId,
			});
			console.log("$$ order", order);
			orderId = metadata.orderId;
			console.log("$$ orderId", orderId);
			console.log("$$ payload.user", payload.user);
		}
		// Look up the order based on message timestamp
		// First try by slack_message_ts if you store it
		// let order = await Order.findOne({ slack_message_ts: messageTs });

		// Update order using findOneAndUpdate
		// const updateData = {
		// 	deleted: true,
		// 	deletedAt: new Date(),
		// 	deletedBy: payload.user ? payload.user.id : payload.user_id || "unknown",
		// 	deletedByName: payload.user
		// 		? payload.user.username
		// 		: payload.username || "unknown",
		// 	...(reason && { deletionReason: reason }), // Conditionally add deletionReason
		// };

		// const updatedOrder = await Order.findOneAndUpdate(
		// 	{ _id: order._id },
		// 	{ $set: updateData },
		// 	{ new: true } // Return the updated document
		// );

		// Update the original message
		if (channelId && messageTs) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.update",
				{
					channel: channelId,
					ts: messageTs,
					text: `❌ *11SUPPRIMÉE* - Commande #${orderId}`,

					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text:
									":package:  ❌ Commande: " +
									orderId +
									" - Supprimée" +
									` par <@${
										payload.user.username
									}> le ${new Date().toLocaleDateString()}, Raison: ` +
									(reason ? ` ${reason}` : " Non spécifiée"),
								emoji: true,
							},
						},
					],
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		// Notify admin channel
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
			},
			process.env.SLACK_BOT_TOKEN
		);
		const channels = [
			process.env.SLACK_FINANCE_CHANNEL_ID,
			order.demandeurId, // Assuming this is a Slack user ID for DM
			process.env.SLACK_ACHAT_CHANNEL_ID,
		];
		console.log("Channels to notify:", channels);
		for (const Channel of channels) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: Channel,
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text:
									":package:  ❌ Commande: " +
									orderId +
									" - Supprimée" +
									` par <@${
										payload.user.username
									}> le ${new Date().toLocaleDateString()}, Raison:` +
									(reason ? ` ${reason}` : " Non spécifiée"),
								emoji: true,
							},
						},
					],
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		return {
			success: true,
			message: `:white_check_mark: Commande #${orderId} supprimée avec succès.`,
		};
	} catch (error) {
		context.log(`Error executing deletion: ${error.message}`, error.stack);
		return {
			success: false,
			message: `❌ Erreur lors de la suppression: ${error.message}`,
		};
	}
}
module.exports = {
	generateCommandId,
	createAndSaveOrder,
	handleOrderListSlack,
	executeOrderDeletion,
	handleOrderOverview,
	handleOrderList,
};
