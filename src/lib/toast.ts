import { Alert, Platform, ToastAndroid } from 'react-native';

/** Feedback curto. Toast nativo no Android; Alert nas demais plataformas. */
export function showToast(message: string): void {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert(message);
  }
}
