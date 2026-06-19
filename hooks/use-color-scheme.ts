import { useColorScheme as useRNColorScheme } from 'react-native';

export type AppColorScheme = 'light' | 'dark';

export function useColorScheme(): AppColorScheme {
  return useRNColorScheme() === 'dark' ? 'dark' : 'light';
}
