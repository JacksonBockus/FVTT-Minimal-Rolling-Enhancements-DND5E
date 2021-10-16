import { libWrapper } from "../../lib/libWrapper/shim.js";
import { MODULE_NAME } from "../const.mjs";
import { SETTING_NAMES } from "../settings.mjs";
import { modifiers } from "../modifiers.mjs";
import { initializeFormulaGroups } from "./initialize-formula-groups.mjs";

/**
 * When I roll an Item, also roll the item check/attack and damage if the options say to do so
 */
export function patchItemBaseRoll() {
    libWrapper.register(MODULE_NAME, "CONFIG.Item.documentClass.prototype.roll", async function patchedRoll(wrapped, ...args) {
        const autoRollCheckSetting = game.settings.get(MODULE_NAME, SETTING_NAMES.AUTO_CHECK);
        const autoRollDamageSetting = game.settings.get(MODULE_NAME, SETTING_NAMES.AUTO_DMG);
        const autoRollCheckWithOverride = this.getFlag(MODULE_NAME, "autoRollAttack") ?? autoRollCheckSetting;
        const autoRollDamageWithOverride = this.getFlag(MODULE_NAME, "autoRollDamage") ?? autoRollDamageSetting;
        const autoRollOther = this.getFlag(MODULE_NAME, "autoRollOther");

        // Call the original Item5e#roll and get the resulting message data
        const messageData = await wrapped(...args);

        // Short circuit if auto roll is off for this user/item
        // OR if User quit out of the dialog workflow early (or some other failure)
        if ((!autoRollCheckWithOverride && !autoRollDamageWithOverride && !autoRollOther) || !messageData) {
            return messageData;
        }

        await initializeFormulaGroups(this);
        const capturedModifiers = foundry.utils.deepClone(modifiers);

        // Make a roll if auto rolls is on
        let checkRoll;
        if (autoRollCheckWithOverride) {
            if (this.hasAttack) {
                checkRoll = await this.rollAttack({ event: capturedModifiers });
            } else if (this.type === "tool") {
                checkRoll = await this.rollToolCheck({ event: capturedModifiers });
            }
        }

        if (this.hasDamage && autoRollDamageWithOverride) {
            const spellLevel = this.data.data.level;

            const options = { event: capturedModifiers, spellLevel };
            if (args.length && Number.isNumeric(args[0].spellLevel)) options.spellLevel = args[0].spellLevel;
            if (checkRoll) {
                options.critical = checkRoll.dice[0].results[0].result >= checkRoll.terms[0].options.critical;
            }
            await this.rollDamage(options);
        }

        if (this.data.data.formula?.length && autoRollOther) {
            await this.rollFormula({ event: capturedModifiers });
        }
    }, "WRAPPER");
}
