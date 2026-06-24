import { NextRequest, NextResponse } from 'next/server';
import { getEnabledApiRegions } from './config';
import { getRealHost } from '../api/utils/url';
import chinaRegions from '../../data/china-regions.json';

// 缓存配置
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24小时
// 使用 Map 存储不同 host 的缓存
const cacheMap = new Map<string, { data: string; timestamp: number }>();

interface Channel {
  name: string;
  url: string;
  group: string;
}

/**
 * 检查频道名称是否已包含地区名
 */
function hasRegionName(channelName: string): boolean {
  // 检查是否包含省级地名
  for (const province of chinaRegions.provinces) {
    if (channelName.includes(province)) {
      return true;
    }
  }
  
  // 检查是否包含地级市地名
  for (const city of chinaRegions.cities) {
    if (channelName.includes(city)) {
      return true;
    }
  }
  
  // 检查是否包含区县地名
  for (const district of chinaRegions.districts) {
    if (channelName.includes(district)) {
      return true;
    }
  }
  
  return false;
}

/**
 * 为频道名添加地区前缀（如果需要）
 */
function addRegionPrefix(channelName: string, prefixName: string): string {
  // 如果已包含地区名，直接返回
  if (hasRegionName(channelName)) {
    return channelName;
  }
  
  // CETV教育频道不加前缀
  if (channelName.startsWith('CETV')) {
    return channelName;
  }
  
  // 央视、4K等特殊分组不加前缀
  if (prefixName === '央视' || prefixName === '4K') {
    return channelName;
  }
  
  // 添加地区前缀
  return `${prefixName}${channelName}`;
}

/**
 * 移除频道名称中的"频道"两字
 */
function removeChannelSuffix(name: string): string {
  return name.replace(/频道$/g, '').trim();
}

/**
 * 解析M3U8内容，提取频道信息
 */
function parseM3U8(content: string, prefixName: string, groupName: string, baseUrl: string): Channel[] {
  const channels: Channel[] = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 查找 #EXTINF 行
    if (line.startsWith('#EXTINF:')) {
      // 提取频道名称
      let channelName = '';
      
      // 提取频道名称（逗号后面的部分）
      const nameMatch = line.match(/,(.+)$/);
      if (nameMatch) {
        channelName = nameMatch[1].trim();
        // 移除可能的表情符号
        channelName = channelName.replace(/^[📺📻🎬?]+\s*/, '');
      }
      
      // 获取下一行的URL
      if (i + 1 < lines.length) {
        let url = lines[i + 1].trim();
        
        if (url && !url.startsWith('#')) {
          // 如果URL是相对路径，转换为绝对路径
          if (!url.startsWith('http')) {
            url = `${baseUrl}${url}`;
          }
          
          // 处理频道名称
          let finalName = removeChannelSuffix(channelName);
          finalName = addRegionPrefix(finalName, prefixName);
          
          // 确定分组：使用groupName
          let finalGroup = groupName;
          
          // 特殊规则：CETV教育频道单独分组
          if (finalName.startsWith('CETV')) {
            finalGroup = '教育';
          }
          // 特殊规则：包含"卫视"的放入卫视分组（除非包含"4K"）
          else if (finalName.includes('卫视')) {
            if (finalName.includes('4K') || finalName.includes('4k')) {
              finalGroup = '4K超高清';
            } else {
              finalGroup = '卫视';
            }
          }
          
          channels.push({
            name: finalName,
            url: url,
            group: finalGroup
          });
        }
      }
    }
  }
  
  return channels;
}

/**
 * 获取单个地区的频道列表
 */
async function fetchRegionChannels(
  api: string,
  prefixName: string,
  groupName: string,
  baseUrl: string
): Promise<Channel[]> {
  try {
    const url = `${baseUrl}/api/${api}?id=list`;
    console.log(`Fetching: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      console.error(`Failed to fetch ${api}: ${response.status}`);
      return [];
    }
    
    const content = await response.text();
    
    // 检查是否是有效的M3U8
    if (!content.includes('#EXTM3U')) {
      console.error(`Invalid M3U8 format for ${api}`);
      return [];
    }
    
    return parseM3U8(content, prefixName, groupName, baseUrl);
  } catch (error) {
    console.error(`Error fetching ${api}:`, error);
    return [];
  }
}

/**
 * 生成M3U8播放列表
 */
function generateM3U8(channelsByGroup: Map<string, Channel[]>): string {
  let m3u8 = '#EXTM3U\n';
  m3u8 += '#PLAYLIST:全国IPTV直播频道汇总\n\n';
  
  // 定义分组优先级：央视、卫视、4K超高清、教育排在最前面
  const priorityGroups = ['央视', '卫视', '4K超高清', '教育'];
  
  // 先输出优先分组
  for (const group of priorityGroups) {
    if (channelsByGroup.has(group)) {
      const channels = channelsByGroup.get(group)!;
      for (const channel of channels) {
        m3u8 += `#EXTINF:-1 group-title="${group}",${channel.name}\n`;
        m3u8 += `${channel.url}\n`;
      }
      m3u8 += '\n';
    }
  }
  
  // 其他分组按字母顺序
  const sortedGroups = Array.from(channelsByGroup.keys())
    .filter(g => !priorityGroups.includes(g))
    .sort();
  
  for (const group of sortedGroups) {
    const channels = channelsByGroup.get(group)!;
    for (const channel of channels) {
      m3u8 += `#EXTINF:-1 group-title="${group}",${channel.name}\n`;
      m3u8 += `${channel.url}\n`;
    }
    m3u8 += '\n';
  }
  
  return m3u8;
}

/**
 * 主处理函数
 */
export async function GET(request: NextRequest) {
  const host = getRealHost(request);
  const baseUrl = `http://${host}`;
  
  // 检查该 host 的缓存
  const now = Date.now();
  const cachedResult = cacheMap.get(host);
  if (cachedResult && (now - cachedResult.timestamp) < CACHE_DURATION) {
    console.log(`返回缓存数据 (host: ${host})`);
    return new NextResponse(cachedResult.data, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  }
  
  console.log(`开始生成新的频道列表... (host: ${host})`);
  
  const apiRegions = getEnabledApiRegions();
  const allChannels: Channel[] = [];
  
  // 并发获取所有地区的频道
  const promises = apiRegions.map(([api, prefixName, groupName]) =>
    fetchRegionChannels(api, prefixName, groupName, baseUrl)
  );
  
  const results = await Promise.allSettled(promises);
  
  // 收集所有成功的结果
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allChannels.push(...result.value);
    } else {
      console.error(`Failed to fetch ${apiRegions[i][0]}:`, result.reason);
    }
  }
  
  console.log(`共获取 ${allChannels.length} 个频道`);
  
  // 按分组整理频道
  const channelsByGroup = new Map<string, Channel[]>();
  for (const channel of allChannels) {
    if (!channelsByGroup.has(channel.group)) {
      channelsByGroup.set(channel.group, []);
    }
    channelsByGroup.get(channel.group)!.push(channel);
  }
  
  // 生成M3U8
  const m3u8Content = generateM3U8(channelsByGroup);
  
  // 更新该 host 的缓存
  cacheMap.set(host, {
    data: m3u8Content,
    timestamp: now
  });
  
  console.log(`生成完成，已缓存 (host: ${host}, 缓存数: ${cacheMap.size})`);
  
  return new NextResponse(m3u8Content, {
    headers: {
      //'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400'
    }
  });
}
