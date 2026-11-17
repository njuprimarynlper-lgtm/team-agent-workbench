import { installErrorLogHost } from './error-log-host';
import { rememberFailure } from './error-notice';
const api = (window as any).workbench || (window as any).admin;
if (api) installErrorLogHost(api);
window.addEventListener('message', event => {
  if (event.source === window && event.data?.type === 'workbench:failure') rememberFailure(event.data.failure);
});
