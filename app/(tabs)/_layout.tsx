import { Tabs } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

function VercelTabIcon({ color, size = 28 }: { color: string; size?: number }) {
  return (
    <View style={[styles.vercelIconBox, { width: size, height: size }]}>
      <View
        style={[
          styles.vercelTriangle,
          {
            borderLeftWidth: size * 0.42,
            borderRightWidth: size * 0.42,
            borderBottomWidth: size * 0.76,
            borderBottomColor: color,
          },
        ]}
      />
    </View>
  );
}

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: false,
        tabBarButton: HapticTab,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="paperplane.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="ship"
        options={{
          title: 'Ship',
          tabBarActiveTintColor: '#ffffff',
          tabBarInactiveTintColor: '#6b7280',
          tabBarStyle: styles.vercelTabBar,
          tabBarIcon: ({ color }) => <VercelTabIcon size={28} color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  vercelIconBox: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  vercelTriangle: {
    width: 0,
    height: 0,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  vercelTabBar: {
    backgroundColor: '#000000',
    borderTopColor: '#1f2937',
  },
});
