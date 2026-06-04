import { StyleSheet } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import ParallaxScrollView from '@/components/parallax-scroll-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Fonts } from '@/constants/theme';

const services = [
  {
    title: 'Engineering',
    body: 'Feature development, end-to-end product delivery, AI-assisted migrations, and architecture or performance work for React Native products.',
  },
  {
    title: 'Infrastructure',
    body: 'AI-driven QA and testing, custom agents, and self-hosted CI/CD infrastructure that helps teams turn agent output into releases.',
  },
  {
    title: 'Adoption & governance',
    body: 'AI tooling setup, adoption measurement, team training, private model strategy, compliance support, and AI security audits.',
  },
];

const highlights = [
  'React Foundation members and React Native core contributors',
  'Open-source contributors across the React Native ecosystem since 2016',
  '100+ enterprise clients and 10+ years helping teams ship cross-platform products',
];

export default function CallstackScreen() {
  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: '#E9F6F4', dark: '#12302F' }}
      headerImage={
        <IconSymbol
          size={260}
          color="#0A7EA4"
          name="briefcase.fill"
          style={styles.headerImage}
        />
      }>
      <ThemedView style={styles.titleContainer}>
        <ThemedText type="title" style={{ fontFamily: Fonts.rounded }}>
          Callstack
        </ThemedText>
      </ThemedView>

      <ThemedText>
        Callstack helps companies ship production-grade React Native and AI-native products. Their
        work spans product engineering, delivery infrastructure, AI adoption, and enterprise
        governance.
      </ThemedText>

      <ThemedView style={styles.section}>
        <ThemedText type="subtitle">What they offer</ThemedText>
        {services.map((service) => (
          <ThemedView key={service.title} style={styles.service}>
            <ThemedText type="defaultSemiBold">{service.title}</ThemedText>
            <ThemedText>{service.body}</ThemedText>
          </ThemedView>
        ))}
      </ThemedView>

      <ThemedView style={styles.section}>
        <ThemedText type="subtitle">Why teams choose them</ThemedText>
        {highlights.map((highlight) => (
          <ThemedView key={highlight} style={styles.highlight}>
            <ThemedText type="defaultSemiBold">-</ThemedText>
            <ThemedText style={styles.highlightText}>{highlight}</ThemedText>
          </ThemedView>
        ))}
      </ThemedView>

      <ExternalLink href="https://www.callstack.com">
        <ThemedText type="link">Visit callstack.com</ThemedText>
      </ExternalLink>
    </ParallaxScrollView>
  );
}

const styles = StyleSheet.create({
  headerImage: {
    bottom: -48,
    opacity: 0.42,
    position: 'absolute',
    right: -24,
  },
  highlight: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
  },
  highlightText: {
    flex: 1,
  },
  section: {
    gap: 12,
  },
  service: {
    gap: 4,
  },
  titleContainer: {
    flexDirection: 'row',
    gap: 8,
  },
});
