import { registerPlugin } from '@capacitor/core';

const AbsToast = registerPlugin('AbsToast', {
  web: () => import('./AbsToast.web').then(m => new m.AbsToastWeb()),
});

export default AbsToast;