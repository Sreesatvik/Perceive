/**
 * Executes a validated action on the real DOM.
 * @param {Object} action — validated server response action
 * @param {Function} resolveToken — Dev 2's vault.resolveToken, bound and passed in
 * @returns {Promise<Object>} — { success: boolean, error?: string, domChanged?: boolean }
 */
export async function executeAction(action, resolveToken) {
    console.log(`[ActionExecutor] Executing action: ${action.type}`);

    if (action.type === 'task_complete' || action.type === 'task_failed') {
        return { success: true, domChanged: false };
    }

    if (action.type === 'wait') {
        const delay = parseInt(action.value, 10) || 1000;
        await new Promise(r => setTimeout(r, delay));
        return { success: true, domChanged: false };
    }

    // For click, type, scroll, we need a target element
    let targetElement = null;
    if (action.target_element_id) {
        targetElement = document.querySelector(`[data-ext-id="${CSS.escape(action.target_element_id)}"]`);
        if (!targetElement) {
            targetElement = document.getElementById(action.target_element_id);
        }
    }

    if (!targetElement && ['click', 'type', 'scroll'].includes(action.type)) {
        return { success: false, error: 'target_element_not_found' };
    }

    // Visibility check
    if (targetElement) {
        const rect = targetElement.getBoundingClientRect();
        const isVisible = (rect.width > 0 && rect.height > 0) &&
                          window.getComputedStyle(targetElement).visibility !== 'hidden';
        if (!isVisible || targetElement.disabled) {
            return { success: false, error: 'element_not_interactable' };
        }
    }

    try {
        switch (action.type) {
            case 'click':
                console.log('[ActionExecutor] Clicking element:', targetElement, 'tag:', targetElement.tagName, 'type:', targetElement.type, 'id:', targetElement.id);

                // TEMPORARILY DISABLED for real-site testing — this preventDefault()
                // blocks genuine form submission, which is needed to verify the
                // agent's task_complete claims are actually true on a real site.
                // RESTORE this block before running in the sandbox/test-harness
                // context, where real navigation would wipe test state.
                //
                // if (targetElement.type === 'submit' || targetElement.tagName === 'BUTTON') {
                //     const form = targetElement.closest('form');
                //     if (form) {
                //         const handler = (e) => e.preventDefault();
                //         form.addEventListener('submit', handler, { once: true });
                //     }
                // }

                targetElement.click();
                return { success: true, domChanged: true };
            case 'type':
                let valueToType = action.value || "";
                
                // Check if it looks like a token, e.g. [CARD_NUMBER_1]
                if (valueToType.startsWith('[') && valueToType.endsWith(']')) {
                    const resolved = resolveToken(valueToType);
                    if (!resolved) {
                        console.warn('[ActionExecutor] Failed to resolve token:', valueToType, '| target:', action.target_element_id);
                        return { success: false, error: 'unresolvable_token' };
                    }
                    valueToType = resolved;
                }

                // Set value and dispatch synthetic events so SPA frameworks pick it up
                targetElement.value = valueToType;
                targetElement.dispatchEvent(new Event('input', { bubbles: true }));
                targetElement.dispatchEvent(new Event('change', { bubbles: true }));
                
                return { success: true, domChanged: true };

            case 'scroll':
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return { success: true, domChanged: false };

            case 'ask_user_confirmation':
                // Will be handled by the orchestrator calling confirmationUI.js
                return { success: true, domChanged: false };

            default:
                return { success: false, error: 'unknown_action_type' };
        }
    } catch (error) {
        console.error(`[ActionExecutor] Error executing ${action.type}:`, error);
        return { success: false, error: error.message };
    }
}