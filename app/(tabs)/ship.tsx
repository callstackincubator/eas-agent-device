import { ExternalLink } from '@/components/external-link';
import { Fonts } from '@/constants/theme';
import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const highlights = [
  'Magazine London',
  'June 17',
  'AI SDK, Sandbox, agents, and Next.js',
];

export default function VercelShipScreen() {
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        indicatorStyle="white">
        <View style={styles.hero}>
          <View style={styles.logoMark} />
          <Text style={styles.eyebrow}>VERCEL SHIP LONDON</Text>
          <Text style={styles.title}>Ship what&apos;s next</Text>
          <Text style={styles.lede}>
            Vercel Ship brings builders together to see how modern products move from idea to
            production with the AI Cloud.
          </Text>
        </View>

        <View style={styles.highlightGrid}>
          {highlights.map((item) => (
            <View key={item} style={styles.highlightItem}>
              <Text style={styles.highlightText}>{item}</Text>
            </View>
          ))}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About Vercel</Text>
          <Text style={styles.paragraph}>
            Vercel gives teams developer tools and cloud infrastructure for building, scaling, and
            securing fast web experiences. Its platform is shaped around framework-defined
            infrastructure: push code, generate previews, and let the platform provision the pieces
            that the application needs.
          </Text>
          <Text style={styles.paragraph}>
            The company is also putting AI-native product development at the center of the stack,
            with products like AI SDK, AI Gateway, Vercel Sandbox, Workflow, and v0 sitting beside
            the core deployment, content delivery, compute, observability, and security platform.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About Ship London</Text>
          <Text style={styles.paragraph}>
            Ship 26 London is Vercel&apos;s June 17 stop at Magazine London. The event spotlights
            the people and systems behind the next wave of web and AI products, including sessions
            on real-time voice agents, AI-generated Next.js apps, and production agent workflows.
          </Text>
          <Text style={styles.paragraph}>
            The London lineup includes Vercel founder and CEO Guillermo Rauch alongside speakers
            from Google DeepMind, ElevenLabs, Callstack, Mintlify, and other teams building at the
            edge of AI application development.
          </Text>
        </View>

        <ExternalLink href="https://vercel.com/ship/london" style={styles.linkButton}>
          <Text style={styles.linkText}>Open Ship London</Text>
        </ExternalLink>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000000',
  },
  scroll: {
    flex: 1,
    backgroundColor: '#000000',
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 48,
    gap: 24,
  },
  hero: {
    minHeight: 260,
    justifyContent: 'flex-end',
    gap: 16,
  },
  logoMark: {
    width: 0,
    height: 0,
    borderLeftWidth: 36,
    borderRightWidth: 36,
    borderBottomWidth: 64,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#ffffff',
    marginBottom: 12,
  },
  eyebrow: {
    color: '#a1a1aa',
    fontFamily: Fonts.mono,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0,
  },
  title: {
    color: '#ffffff',
    fontFamily: Fonts.sans,
    fontSize: 48,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 52,
  },
  lede: {
    color: '#d4d4d8',
    fontSize: 18,
    lineHeight: 28,
    maxWidth: 680,
  },
  highlightGrid: {
    gap: 10,
  },
  highlightItem: {
    borderColor: '#27272a',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#09090b',
  },
  highlightText: {
    color: '#fafafa',
    fontSize: 15,
    fontWeight: '700',
  },
  section: {
    gap: 12,
    borderTopColor: '#27272a',
    borderTopWidth: 1,
    paddingTop: 24,
  },
  sectionTitle: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 28,
  },
  paragraph: {
    color: '#d4d4d8',
    fontSize: 16,
    lineHeight: 25,
  },
  linkButton: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    marginTop: 8,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  linkText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '800',
  },
});
