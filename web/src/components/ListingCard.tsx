import type { ReactElement } from 'react';
import type { FeedItem, ProfileSummary } from '@shared/api-types';
import { relTime } from '../lib/format';
import { plural } from '../lib/labels';
import { Badges } from './Badges';
import { FeatureChips } from './FeatureChips';
import { PriceLine } from './PriceLine';
import { ScoreBadge } from './ScoreBadge';
import { StateActions } from './StateActions';

interface Props {
  item: FeedItem;
  profile: ProfileSummary;
  selected: boolean;
  href: string;
  onOpen: () => void;
  onStateChanged: () => void;
}

/** The Telegram message, laid out. Everything above the score breakdown is here; the rest is on the detail. */
export function ListingCard({ item, profile, selected, href, onOpen, onStateChanged }: Props): ReactElement {
  const l = item.listing;
  const classes = ['card'];
  if (selected) classes.push('selected');
  if (item.state.status === 'dismissed') classes.push('dismissed');
  if (l.delistedAt) classes.push('delisted');

  return (
    <article className={classes.join(' ')}>
      <a
        className="card-link"
        href={href}
        onClick={(e) => {
          // Plain click opens in place; a modifier click keeps the browser's open-in-new-tab.
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          onOpen();
        }}
      >
        <ScoreBadge score={item.score} minScore={profile.minScore} />
        <div className="card-body">
          <h3 className="card-title">{l.title}</h3>
          <PriceLine listing={l} />
          <FeatureChips listing={l} compact />
          <p className="where">
            📍 {l.address ?? 'endereço não informado'}
            {l.city ? ` · ${l.city}` : ''}
            {item.area && item.area !== l.city ? ` · ${item.area}` : ''}
          </p>
          <Badges item={item} />
          <p className="meta muted small">
            visto {relTime(l.firstSeenAt)}
            {l.postedAt ? ` · publicado ${relTime(l.postedAt)}` : ''}
            {item.duplicates > 0
              ? ` · ${item.duplicates} ${plural(item.duplicates, 'outro anúncio', 'outros anúncios')} do mesmo imóvel`
              : ''}
          </p>
        </div>
      </a>
      <StateActions listingId={l.id} profileId={profile.id} state={item.state} compact onChanged={onStateChanged} />
    </article>
  );
}
