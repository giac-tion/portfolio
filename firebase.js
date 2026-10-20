import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  browserLocalPersistence, getAuth, GoogleAuthProvider, setPersistence
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCjrpdzRYFcnvGMoFg8PHY3EppYS7eTYCc',
  authDomain: 'portfolio-36344.firebaseapp.com',
  projectId: 'portfolio-36344',
  storageBucket: 'portfolio-36344.firebasestorage.app',
  messagingSenderId: '13344479629',
  appId: '1:13344479629:web:1e9a9c95f855d2d71685c4'
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const authPersistenceReady = setPersistence(auth, browserLocalPersistence);
export const database = getFirestore(firebaseApp);
export const provider = new GoogleAuthProvider();
