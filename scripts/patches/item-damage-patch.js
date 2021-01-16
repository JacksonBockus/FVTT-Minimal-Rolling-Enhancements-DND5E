import { MODULE_NAME } from "../const.js";
import { libWrapper } from "../../lib/libWrapper/shim.js";
import { getModifierSettingLocalOrDefault } from "../settings.js";

export function patchItemRollDamage() {
    libWrapper.register(MODULE_NAME, "CONFIG.Item.entityClass.prototype.rollDamage", async function (wrapped, ...args) {
        let {/** @type MouseEvent */ event=null, formulaGroup=0, options={}} = args[0];

        if (!this.data.data.damage?.parts) throw new Error("You cannot roll damage for this item.");

        let showDamageDialog = getModifierSettingLocalOrDefault("showRollDialogModifier");

        let title = `${this.name} - ${game.i18n.localize("DND5E.DamageRoll")}`;
        let rollMode = options.rollMode ?? game.settings.get("core", "rollMode");
        let critical = false;
        let bonus = null;

        // Show a custom dialog that applies to all damage parts
        if (event && event[showDamageDialog]) {
            const dialogOptions = {
                top: event?.clientY ? event.clientY - 80 : null,
                left: event?.clientX ? window.innerWidth - 710 : null,
            };
            const dialogData = await _damageDialog({ title, rollMode, dialogOptions });

            if (!dialogData) return null;

            critical = dialogData?.critical ?? critical;
            rollMode = dialogData?.rollMode ?? rollMode;
            bonus = dialogData?.bonus ?? bonus;
        }

        // Skip core dnd5e dialog
        if (!args[0].options) args[0].options = {};
        args[0].options.fastForward = true;
        args[0].critical = critical;

        // Roll each individual damage formula
        const group = (this.getFlag(MODULE_NAME, "formulaGroups"))[formulaGroup];
        if (!group) throw new Error(`Invalid formula group index provided: ${formulaGroup}`);
        title += ` (${group.label})`;
        const itemFormulae = this.data.data.damage.parts;
        const groupDamageParts = group.formulaSet.map(f => itemFormulae[f]);
        if (groupDamageParts.every(p => p === undefined)) {
            const msg = game.i18n.format(`${MODULE_NAME}.FORMULA-GROUP.GroupEmptyError`, group);
            ui.notifications.error(msg);
            throw new Error(msg);
        }
        const partRolls = await _rollDamageParts(this.data.data.damage, groupDamageParts, wrapped, args[0]);

        // Add a situational bonus if one was provided
        if (bonus) {
            const bonusRoll = new Roll(bonus);
            if (critical) {
                bonusRoll.alter(2, 0);
            }
            partRolls.push({ roll: bonusRoll.roll(), flavor: game.i18n.localize("DND5E.RollSituationalBonus").slice(0, -1) })
        }

        // Prepare the chat message content
        const renderedContent = await _renderCombinedDamageRollContent(this, partRolls);

        const messageData = await _createCombinedDamageMessageData(this, renderedContent, title, partRolls, critical, rollMode, options);

        if (options.chatMessage ?? true) {
            // Show DSN 3d dice if available
            if (game.dice3d) {
                const rollAnims =
                    partRolls.map(part => game.dice3d.showForRoll(part.roll, game.user, true, messageData.whisper, messageData.blind));
                await Promise.all(rollAnims);
            }

            await ChatMessage.create(messageData);
        }

        // Return the array of Roll objects
        return partRolls;
    }, "MIXED");
}

/**
 * @returns {Promise<{ critical: Boolean, bonus: Number, rollMode: String }>}
 * @private
 */
async function _damageDialog({ title, rollMode, dialogOptions }={}) {
    const template = "systems/dnd5e/templates/chat/roll-dialog.html";
    const dialogData = {
        formula: "",
        rollMode: rollMode,
        rollModes: CONFIG.Dice.rollModes,
    };
    const content = $(await renderTemplate(template, dialogData));

    content.find("[name=formula]").closest(".form-group").remove();

    return new Promise(resolve => {
        new Dialog({
            title,
            content: content.prop("outerHTML"),
            buttons: {
                critical: {
                    label: game.i18n.localize("DND5E.CriticalHit"),
                    callback: html => resolve({ critical: true, ..._parseDamageDialog(html[0].querySelector("form")) })
                },
                normal: {
                    label: game.i18n.localize("DND5E.Normal"),
                    callback: html => resolve({ critical: false, ..._parseDamageDialog(html[0].querySelector("form")) })
                },
            },
            default: "normal",
            close: () => resolve(null)
        }, dialogOptions).render(true);
    });
}

function _parseDamageDialog(form) {
    return form ? {
        bonus: form.bonus.value,
        rollMode: form.rollMode.value,
    } : {};
}

async function _rollDamageParts(itemDamage, groupDamageParts, innerRollDamage, { critical, event, spellLevel, versatile, options }) {
    const partRolls = [];

    const originalItemDamageParts = duplicate(itemDamage.parts);

    // Roll each of the item's damage parts separately.
    for (let [formula, type] of groupDamageParts) {
        const partOptions = duplicate(options);
        partOptions.chatMessage = false;

        // Override the item's damage so that the original roll damage function only rolls one "part" at a time.
        itemDamage.parts = [[formula, type]];
        /** @type Roll */
        const roll = await innerRollDamage({
            critical,
            event,
            spellLevel,
            versatile,
            options: partOptions,
        });
        if (!roll) continue;
        partRolls.push({ roll, flavor: `${CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes[type]}` });
    }

    itemDamage.parts = originalItemDamageParts;
    return partRolls;
}

async function _renderCombinedDamageRollContent(item, rolls) {
    const renderedRolls = [];

    // Render all each of the rolls to html
    for (let part of rolls) {
        const rendered = $(await part.roll.render());
        const formulaElement = rendered.find(".dice-total");
        formulaElement.attr("data-damage-type", part.flavor);
        renderedRolls.push(rendered);
    }

    // Assemble them under one container div
    const container = $(`<div class="dnd5e chat-card item-card mre-damage-card">`);
    container.append(`<div class="card-content">`);
    const damageSection = $(`<div class="card-roll formula-group">`);
    damageSection.append(renderedRolls);
    damageSection.find(".dice-roll:not(:last-child)").after("<hr />");
    container.append(damageSection);

    return container.prop("outerHTML");
}

async function _createCombinedDamageMessageData(item, content, flavor, rolls, critical, rollMode, options) {
    // This decoy roll is used to convince foundry that the message has ROLL type
    const decoyRoll = new Roll("0").roll();

    // Set up data for the final message to be sent
    const messageData = {
        user: game.user._id,
        content,
        flavor,
        roll: decoyRoll,
        speaker: ChatMessage.getSpeaker({actor: item.actor}),
        sound: CONFIG.sounds.dice,
        type: CONST.CHAT_MESSAGE_TYPES.ROLL,
        "flags.dnd5e.roll": {type: "damage", itemId: item.id },
        "flags.mre-dnd5e.rolls": rolls.map(r => r.roll.toJSON()),
    };

    if (critical) {
        messageData.flavor += ` (${game.i18n.localize("DND5E.Critical")})`;
        messageData["flags.dnd5e.roll"].critical = true;
    }

    ChatMessage.applyRollMode(messageData, rollMode);

    // Merge with data passed into the function call
    mergeObject(messageData, options, { insertKeys: false });
    mergeObject(messageData, options.messageData);

    return messageData;
}
