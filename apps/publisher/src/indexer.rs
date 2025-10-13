use mp4::{BoxHeader, BoxType, MoofBox, MoovBox, ReadBox};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Seek, SeekFrom};

#[derive(Debug)]
pub struct InitRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug)]
pub struct Frag {
    pub track_id: u32,
    pub tfdt: u64,
    pub group: u64,
    pub object: u32,
    pub moof_start: u64,
    pub mdat_start: u64,
    pub mdat_size: u64,
}

#[derive(Debug)]
pub struct Mp4Index {
    pub init: InitRange,
    pub timescale: HashMap<u32, u32>,
    pub delay: HashMap<u32, u64>,
    pub frags: Vec<Frag>,
}


pub fn build_index(path: &str) -> Result<Mp4Index, Box<dyn std::error::Error>> {
    let f = File::open(path)?;
    let mut r = BufReader::new(f);

    let mut timescale = HashMap::new();
    let mut delay = HashMap::new();
    let mut frags = Vec::new();

    let mut ftyp_start = 0u64;
    let mut moov_start = 0u64;
    let mut moov_size = 0u64;
    let mut grp_counters: HashMap<u32, HashMap<u64, u32>> = HashMap::new();

    while let Ok(h) = BoxHeader::read(&mut r) {
        let payload_pos = r.seek(SeekFrom::Current(0))?;
        if h.size == 0 {
            break;
        }
        let box_start = payload_pos - 8;

        match h.name {
            BoxType::FtypBox => {
                ftyp_start = box_start;
                r.seek(SeekFrom::Current((h.size as i64) - 8))?;
            }
            BoxType::MoovBox => {
                moov_start = box_start;
                moov_size = h.size as u64;
                let moov = MoovBox::read_box(&mut r, h.size)?;
                for trak in &moov.traks {
                    timescale.insert(trak.tkhd.track_id, trak.mdia.mdhd.timescale);
                    if let Some(edts) = &trak.edts {
                        if let Some(elst) = &edts.elst {
                            if elst.entries.len() == 1 {
                                delay.insert(trak.tkhd.track_id, elst.entries[0].media_time);
                            }
                        }
                    }
                }
            }
            BoxType::MoofBox => {
                let moof_start = box_start;
                let moof = MoofBox::read_box(&mut r, h.size)?;
                let next = BoxHeader::read(&mut r)?;
                if next.name != BoxType::MdatBox {
                    r.seek(SeekFrom::Current((next.size as i64) - 8))?;
                    continue;
                }
                let mdat_payload_pos = r.seek(SeekFrom::Current(0))?;
                let mdat_start = mdat_payload_pos - 8;
                let mdat_size = next.size as u64;
                r.seek(SeekFrom::Current((next.size as i64) - 8))?;

                if moof.trafs.is_empty() {
                    continue;
                }
                for traf in &moof.trafs {
                    let track_id = traf.tfhd.track_id;
                    if let Some(tfdt) = &traf.tfdt {
                        let ts = *timescale.get(&track_id).unwrap_or(&1);
                        let dly = *delay.get(&track_id).unwrap_or(&0);
                        let adj = tfdt.base_media_decode_time.saturating_add(dly);
                        let group = (adj as u128 / ts as u128) as u64;

                        let entry = grp_counters
                            .entry(track_id)
                            .or_default()
                            .entry(group)
                            .or_insert(0);
                        let object = *entry;
                        *entry += 1;

                        frags.push(Frag {
                            track_id,
                            tfdt: tfdt.base_media_decode_time,
                            group,
                            object,
                            moof_start,
                            mdat_start,
                            mdat_size,
                        });
                    }
                }
            }
            _ => {
                r.seek(SeekFrom::Current((h.size as i64) - 8))?;
            }
        }
    }

    frags.sort_by(|a, b| a.group.cmp(&b.group).then(a.object.cmp(&b.object)));

    Ok(Mp4Index {
        init: InitRange {
            start: ftyp_start,
            end: moov_start + moov_size,
        },
        timescale,
        delay,
        frags,
    })
}
