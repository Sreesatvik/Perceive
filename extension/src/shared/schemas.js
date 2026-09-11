// Minimal validation logic since we don't have Pydantic on the client
// but we want to ensure the server response is structurally sound before executing.

export function validateActionResponse(response, expectedSessionId, expectedStep) {
  if (!response || typeof response !== 'object') throw new Error('Invalid response');
  if (response.session_id !== expectedSessionId) throw new Error('Session mismatch');
  if (response.step_number !== expectedStep + 1) throw new Error('Step mismatch');
  if (!response.action || typeof response.action !== 'object') throw new Error('Missing action');
  const validTypes = ['click','type','scroll','wait','ask_user_confirmation','task_complete','task_failed'];
  if (!validTypes.includes(response.action.type)) throw new Error('Invalid action type');
  if (!['safe','risky'].includes(response.action.risk_tier)) throw new Error('Invalid risk tier');
  return true;
}
