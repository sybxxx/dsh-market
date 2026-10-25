import React from 'react'
import { createRoot } from 'react-dom/client'
import { MarketSection } from '../../src/client/MarketSection.tsx'
import { en, zh } from '../../src/client/locales.ts'
import './source-tools-preview.css'

const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh'
const dictionary = lang === 'en' ? en : zh
const snapshot = { active: lang }
createRoot(document.getElementById('root')!).render(<MarketSection
  t={key => dictionary[key as keyof typeof dictionary] ?? key}
  locale={{ subscribe: () => () => {}, getSnapshot: () => snapshot }}
  theme={{ setTheme: () => {} }}
  themeStore={{ subscribe: () => () => {}, getSnapshot: () => null }}
/> )
