const {
	getMessageReference,
	saveMessageReference,
} = require("../../database/databaseUtils");
const { postSlackMessageWithRetry } = require("../../Handlers/slackApiUtils");
const { getOrderBlocks, getProformaBlocks } = require("../Order/blockBuilders");

// Modifiez notifyTeams pour sauvegarder la référence du message dans le canal achat
async function notifyTeams(payload, order, context) {
	console.log("** notifyTeams");
	console.log("notifyTeams1", notifyTeams);
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];
	const validatedBy = payload.user.id;
	console.log("validatedBy1", validatedBy);

	const channel =
		order.proformas.length === 0
			? process.env.SLACK_ACHAT_CHANNEL_ID
			: process.env.SLACK_FINANCE_CHANNEL_ID;

	const text =
		order.proformas.length === 0
			? `🛒 Commande ${order.id_commande} à traiter - Validé par: <@${validatedBy}>`
			: `💰 Commande ${order.id_commande} en attente de validation financière - Validé par: <@${validatedBy}>`;

	console.log("text:", text);

	const blocks =
		order.proformas.length === 0
			? [
					...getOrderBlocks(order, requestDate),
					...getProformaBlocks(order),
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Ajouter des proformas",
									emoji: true,
								},
								style: "primary",
								action_id: "proforma_form",
								value: order.id_commande,
							},
						],
					},
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `✅ Validé par: <@${validatedBy}>`,
							},
						],
					},
			  ]
			: [
					...getOrderBlocks(order, requestDate),
					...getProformaBlocks1(order),
					{
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
								value: order.id_commande,
							},
						],
					},
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `✅ Validé par: <@${validatedBy}>`,
							},
						],
					},
			  ];

	const response = await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{ text, channel, blocks },
		process.env.SLACK_BOT_TOKEN,
		context
	);

	console.log("Slack API response:", response);

	// Sauvegardez la référence du message pour le canal approprié
	if (response.ok) {
		const messageType =
			channel === process.env.SLACK_ACHAT_CHANNEL_ID ? "achat" : "finance";
		await saveMessageReference(
			order.id_commande,
			response.ts,
			channel,
			messageType
		);
	}

	return response;
}
// Modifiez notifyAdminProforma pour mettre à jour le message existant
async function notifyAdminProforma(order, context, proformaIndex) {
	console.log("** notifyAdminProforma");
	context.log(
		`notifyTeams called for order ${
			order.id_commande
		} at ${new Date().toISOString()}`
	);
	const proformas = order.proformas || [];
	const hasValidated = proformas.some((p) => p.validated);
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];

	// Create blocks for the achat channel
	const achatBlocks = [
		...getOrderBlocks(order, requestDate),
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `⇒ Proformas`,
				emoji: true,
			},
		},
		...proformas
			.map((p, i) =>
				[
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*${p.nom}* - Fournisseur: *${p.fournisseur}* - Montant: *${
								p.montant
							}* ${p.devise}\n   *URLs:*\n${p.urls
								.map((url, j) => `     ${j + 1}. <${url}|Page ${j + 1}>`)
								.join("\n")}`,
						},
					},
					p.validated
						? {
								type: "context",
								elements: [
									{
										type: "mrkdwn",
										text: `:white_check_mark: Validée ${
											p.validatedAt
												? `le ${new Date(p.validatedAt).toLocaleString()}`
												: ""
										} ${p.validatedBy ? `par <@${p.validatedBy}>` : ""}`,
									},
								],
						  }
						: !hasValidated // Only show buttons if no proforma is validated yet
						? {
								type: "actions",
								elements: [
									{
										type: "button",
										text: { type: "plain_text", text: "Modifier", emoji: true },
										value: JSON.stringify({
											orderId: order.id_commande,
											proformaIndex: i,
										}),
										action_id: "edit_proforma",
									},
									{
										type: "button",
										text: {
											type: "plain_text",
											text: "Supprimer",
											emoji: true,
										},
										style: "danger",
										value: JSON.stringify({
											orderId: order.id_commande,
											proformaIndex: i,
										}),
										action_id: "confirm_delete_proforma",
									},
								],
						  }
						: null,
					{ type: "divider" },
				].filter(Boolean)
			)
			.flat(),
	];
	if (!hasValidated) {
		achatBlocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Ajouter des proformas",
						emoji: true,
					},
					style: "primary",
					action_id: "proforma_form",
					value: order.id_commande,
				},
			],
		});
	}
	console.log("$ achatBlocks", achatBlocks);
	console.log("$ hasValidated", hasValidated);

	// Create admin blocks
	const adminBlocks = [
		...getOrderBlocks(order, requestDate),
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `⇒ Proformas `,
				emoji: true,
			},
		},
		...proformas
			.map((p, i) =>
				[
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*${p.nom}* - Fournisseur: *${p.fournisseur}* - Montant: *${
								p.montant
							}* ${p.devise}\n   *URLs:*\n${p.urls
								.map((url, j) => `     ${j + 1}. <${url}|Page ${j + 1}>`)
								.join("\n")}`,
						},
					},
					p.validated
						? {
								type: "context",
								elements: [
									{
										type: "mrkdwn",
										text: `:white_check_mark: Validée ${
											p.validatedAt
												? `le ${new Date(p.validatedAt).toLocaleString()}`
												: ""
										} ${p.validatedBy ? `par <@${p.validatedBy}>` : ""}`,
									},
								],
						  }
						: !hasValidated
						? {
								type: "actions",
								elements: [
									{
										type: "button",
										text: { type: "plain_text", text: "Valider", emoji: true },
										style: "primary",
										value: JSON.stringify({
											orderId: order.id_commande,
											proformaIndex: i,
										}),
										action_id: "confirm_validate_proforma",
									},
								],
						  }
						: null,
					{ type: "divider" },
				].filter(Boolean)
			)
			.flat(),
	];

	adminBlocks.push({
		type: "actions",
		elements: [
			{
				type: "button",
				text: {
					type: "plain_text",
					text: "Supprimer la commande",
					emoji: true,
				},
				style: "danger",
				value: `proforma_${proformaIndex}`,
				action_id: "delete_order",
			},
		],
	});

	try {
		// D'abord, mise à jour du message dans le canal achat
		try {
			// Récupérer la référence du message existant pour l'équipe achat
			const achatMessageRef = await getMessageReference(
				order.id_commande,
				"achat"
			);

			if (achatMessageRef && achatMessageRef.messageTs) {
				// Mettre à jour le message existant
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.update",
					{
						channel: achatMessageRef.channelId,
						ts: achatMessageRef.messageTs,
						text: `Proformas pour ${order.id_commande} (Mis à jour)`,
						blocks: achatBlocks,
					},
					process.env.SLACK_BOT_TOKEN,
					context
				);
			} else {
				// Si aucun message existant n'est trouvé, créer un nouveau message
				const achatResponse = await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: process.env.SLACK_ACHAT_CHANNEL_ID,
						text: `Proformas pour ${order.id_commande}`,
						blocks: achatBlocks,
					},
					process.env.SLACK_BOT_TOKEN,
					context
				);

				// Sauvegarder la référence au nouveau message achat
				if (achatResponse.ok) {
					await saveMessageReference(
						order.id_commande,
						achatResponse.ts,
						process.env.SLACK_ACHAT_CHANNEL_ID,
						"achat"
					);
				}
			}
		} catch (achatError) {
			context.log(
				`Warning: Failed to update achat channel: ${achatError.message}`
			);
		}

		// Maintenant, gérer la notification admin
		// const adminMessageRef = await getMessageReference(
		//   order.id_commande,
		//   "admin"
		// );
		// Find the correct Slack message in the array
		const adminMessage = order.slackMessages.find(
			(msg) => msg.messageType === "notification"
		);
		const adminMessageRef = adminMessage ? adminMessage : undefined;

		if (adminMessageRef && adminMessageRef.ts) {
			// Mettre à jour le message admin existant
			try {
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.update",
					{
						channel: adminMessageRef.channel,
						ts: adminMessageRef.ts,
						text: `Proformas pour ${order.id_commande} (Mis à jour)`,
						blocks: adminBlocks,
					},
					process.env.SLACK_BOT_TOKEN,
					context
				);
			} catch (updateError) {
				context.log(`❌ Error updating admin message: ${updateError.message}`);
			}
		} else {
			// Créer un nouveau message admin si aucune référence n'existe
			const postResponse = await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: `Proformas pour ${order.id_commande}`,
					blocks: adminBlocks,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			);

			// Sauvegarder la référence au nouveau message admin
			if (postResponse.ok) {
				await saveMessageReference(
					order.id_commande,
					postResponse.ts,
					process.env.SLACK_ADMIN_ID,
					"admin"
				);
			}
		}

		return { success: true };
	} catch (error) {
		context.log(
			`❌ Error in notifyAdminProforma: ${error.message}\nStack: ${error.stack}`
		);
		return { success: false, error: error.message };
	}
}
function getProformaBlocks1(order) {
	console.log("** getProformaBlocks1");
	const proformas = order.proformas || [];
	// Filter for validated proformas only when sending to finance (proformas.length > 0 implies finance notification)
	const relevantProformas =
		proformas.length > 0
			? proformas.filter((p) => p.validated === true)
			: proformas;

	return relevantProformas.length > 0
		? relevantProformas
				.map(
					(p) => (
						{ type: "section", text: { type: "mrkdwn", text: `*Proforma*` } },
						{
							type: "section", // Ensure correct type (no typo like "s ection")
							text: {
								type: "mrkdwn",
								text: `*${p.nom}*${
									p.fournisseur ? ` - Fournisseur: *${p.fournisseur}*` : ""
								} - Montant: *${p.montant}* ${p.devise}\n   *URLs:*\n${p.urls
									.map((url, j) => `     ${j + 1}. <${url}|Page ${j + 1}>`)
									.join("\n")}`,
							},
						}
					)
				)
				.concat([{ type: "divider" }])
		: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Proformas - Aucun proforma validé disponible*",
					},
				},
				{ type: "divider" },
		  ];
}

module.exports = {
	notifyTeams,
	notifyAdminProforma,
	getProformaBlocks1,
};
