import { initializeApp, getAuth, getFirestore, getFunctions, firebaseConfig } from '../lib/firebase';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, 'europe-west1');

export { firebaseConfig, initializeApp };
export default app;
