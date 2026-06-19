import { useEffect, useState } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

import type { AppColorScheme } from '@/hooks/use-color-scheme';

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 */
export function useColorScheme(): AppColorScheme {
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  const colorScheme = useRNColorScheme();

  if (hasHydrated) {
    return colorScheme === 'dark' ? 'dark' : 'light';
  }

  return 'light';
}
