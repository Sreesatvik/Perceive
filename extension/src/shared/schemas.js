// Minimal validation logic since we don't have Pydantic on the client
// but we want to ensure the server response is structurally sound before executing.

export function validateActionResponse(response, expectedSessionId, expectedStep) {
  if (!response || typeof response !== 'object') throw new Error('Invalid response');
  if (response.session_id !== expectedSessionId) throw new Error('Session mismatch');

  // Phase C.2(c): a field_mapping response (returned for a
  // field_mapping_request payload — see task-entity-extractor.js's
  // extractCandidateValueSlots) is a structural slot->field-purpose
  // mapping, not a new action/step. It intentionally echoes step_number
  // back UNCHANGED (it doesn't advance session history) and has no
  // `action` at all — validated separately from the normal action shape.
  if (response.field_mapping !== undefined && response.field_mapping !== null) {
    if (response.step_number !== expectedStep) throw new Error('Step mismatch (field_mapping)');
    if (typeof response.field_mapping !== 'object') throw new Error('Invalid field_mapping');
    return true;
  }

  if (response.step_number !== expectedStep + 1) throw new Error('Step mismatch');
  if (!response.action || typeof response.action !== 'object') throw new Error('Missing action');
  const validTypes = ['click','type','scroll','wait','ask_user_confirmation','task_complete','task_failed'];
  if (!validTypes.includes(response.action.type)) throw new Error('Invalid action type');
  if (!['safe','risky'].includes(response.action.risk_tier)) throw new Error('Invalid risk tier');
  return true;
}
